import * as sharedExceptions from '@cairncms/exceptions';
import type {
	Accountability,
	ActionHandler,
	FilterHandler,
	Flow,
	Operation,
	OperationHandler,
	SchemaOverview,
} from '@cairncms/types';
import { Action } from '@cairncms/constants';
import { applyOptionsData, isValidJSON, parseJSON, toArray } from '@cairncms/utils';
import type { Knex } from 'knex';
import { omit, pick } from 'lodash-es';
import { get } from 'micromustache';
import { schedule, validate } from 'node-cron';
import getDatabase from './database/index.js';
import emitter from './emitter.js';
import env from './env.js';
import * as exceptions from './exceptions/index.js';
import { BaseException } from '@cairncms/exceptions';
import logger from './logger.js';
import { getMessenger } from './messenger.js';
import { ActivityService } from './services/activity.js';
import { AuthorizationService } from './services/authorization.js';
import * as services from './services/index.js';
import { FlowsService } from './services/flows.js';
import { RevisionsService } from './services/revisions.js';
import type { EventHandler } from './types/index.js';
import { constructFlowTree } from './utils/construct-flow-tree.js';
import { getSchema } from './utils/get-schema.js';
import { JobQueue } from './utils/job-queue.js';
import { mapValuesDeep } from './utils/map-values-deep.js';
import { collectSensitiveValues, redactFlowLog } from './utils/redact-flow-log.js';
import type { ConfinedOperationResult } from './extensions/confined/operation.js';

/**
 * A registered confined Flow operation. `run` executes the gate-probed entry in the
 * confined child and returns a sanitized outcome plus the values to redact from the
 * revision. `referenceKeys` are the declared reference option keys, key-redacted
 * from the revision so a malformed or nested sensitive value cannot persist.
 */
export interface ConfinedOperationDescriptor {
	run: (params: {
		operationId: string;
		options: Record<string, unknown>;
		input: unknown;
		accountability: Accountability | null;
	}) => Promise<ConfinedOperationResult>;
	referenceKeys: string[];
}

let flowManager: FlowManager | undefined;

export type Step = {
	operation: string;
	key: string;
	status: 'resolve' | 'reject' | 'unknown';
	options: Record<string, any> | null;
};

export function buildRevisionData(
	steps: ReadonlyArray<Step>,
	keyedData: Record<string, unknown>,
	extraSensitiveValues: ReadonlyArray<string> = [],
	extraSensitiveKeys: ReadonlySet<string> = new Set()
): { steps: ReadonlyArray<Step>; data: Record<string, unknown> } {
	const revisionData = omit(keyedData, '$accountability.permissions');
	const sensitiveValues = collectSensitiveValues(revisionData);

	for (const value of extraSensitiveValues) sensitiveValues.add(value);

	// redactFlowLog matches sensitive keys case-insensitively against a lowercased
	// candidate, so a declared key like `apiKey` is lowercased to match.
	const sensitiveKeys = new Set([...extraSensitiveKeys].map((key) => key.toLowerCase()));

	return {
		steps: redactFlowLog(steps, sensitiveValues, sensitiveKeys),
		data: redactFlowLog(revisionData, sensitiveValues, sensitiveKeys) as Record<string, unknown>,
	};
}

export function getFlowManager(): FlowManager {
	if (flowManager) {
		return flowManager;
	}

	flowManager = new FlowManager();

	return flowManager;
}

type TriggerHandler = {
	id: string;
	events: EventHandler[];
};

const TRIGGER_KEY = '$trigger';
const ACCOUNTABILITY_KEY = '$accountability';
const LAST_KEY = '$last';
const ENV_KEY = '$env';

class FlowManager {
	private isLoaded = false;

	// A Map, not a plain object, so an operation type that collides with an inherited
	// object key (constructor, __proto__) cannot be misread as a registered handler.
	private operations: Map<string, OperationHandler> = new Map();

	// Confined operation descriptors, keyed by operation type. A null value marks an
	// ambiguous type declared by more than one confined operation, which runs neither.
	private confinedOperations: Map<string, ConfinedOperationDescriptor | null> = new Map();

	private triggerHandlers: TriggerHandler[] = [];
	private operationFlowHandlers: Record<string, any> = {};
	private webhookFlowHandlers: Record<string, any> = {};

	private reloadQueue: JobQueue;

	constructor() {
		this.reloadQueue = new JobQueue();

		const messenger = getMessenger();

		messenger.subscribe('flows', (event) => {
			if (event['type'] === 'reload') {
				this.reloadQueue.enqueue(async () => {
					if (this.isLoaded) {
						await this.unload();
						await this.load();
					} else {
						logger.warn('Flows have to be loaded before they can be reloaded');
					}
				});
			}
		});
	}

	public async initialize(): Promise<void> {
		if (!this.isLoaded) {
			await this.load();
		}
	}

	public async reload(): Promise<void> {
		const messenger = getMessenger();

		messenger.publish('flows', { type: 'reload' });
	}

	public addOperation(id: string, operation: OperationHandler): void {
		this.operations.set(id, operation);
	}

	public clearOperations(): void {
		this.operations.clear();
	}

	public addConfinedOperation(id: string, descriptor: ConfinedOperationDescriptor): void {
		// A second descriptor for the same id is ambiguous: the type runs neither, so an
		// operator can never be silently routed to one of two operations sharing an id.
		this.confinedOperations.set(id, this.confinedOperations.has(id) ? null : descriptor);
	}

	public markConfinedOperationAmbiguous(id: string): void {
		// The loader resolved a duplicate id and registered none of its descriptors, so
		// the id is recorded ambiguous here too. A flow referencing it then takes the
		// sanitized reject path rather than the missing-operation unknown path.
		this.confinedOperations.set(id, null);
	}

	public hasConfinedOperation(id: string): boolean {
		return this.confinedOperations.has(id);
	}

	public hasOperation(id: string): boolean {
		return this.operations.has(id);
	}

	public clearConfinedOperations(): void {
		this.confinedOperations.clear();
	}

	public async runOperationFlow(id: string, data: unknown, context: Record<string, unknown>): Promise<unknown> {
		if (!(id in this.operationFlowHandlers)) {
			logger.warn(`Couldn't find operation triggered flow with id "${id}"`);
			return null;
		}

		const handler = this.operationFlowHandlers[id];

		return handler(data, context);
	}

	public async runWebhookFlow(
		id: string,
		data: unknown,
		context: Record<string, unknown>
	): Promise<{ result: unknown; cacheEnabled: boolean }> {
		if (!(id in this.webhookFlowHandlers)) {
			logger.warn(`Couldn't find webhook or manual triggered flow with id "${id}"`);
			throw new exceptions.ForbiddenException();
		}

		const handler = this.webhookFlowHandlers[id];

		return handler(data, context);
	}

	private async load(): Promise<void> {
		const flowsService = new FlowsService({ knex: getDatabase(), schema: await getSchema() });

		const flows = await flowsService.readByQuery({
			filter: { status: { _eq: 'active' } },
			fields: ['*', 'operations.*'],
			limit: -1,
		});

		const flowTrees = flows.map((flow) => constructFlowTree(flow));

		for (const flow of flowTrees) {
			if (flow.trigger === 'event') {
				let events: string[] = [];

				if (flow.options?.['scope']) {
					events = toArray(flow.options['scope'])
						.map((scope: string) => {
							if (['items.create', 'items.update', 'items.delete'].includes(scope)) {
								if (!flow.options?.['collections']) return [];

								return toArray(flow.options['collections']).map((collection: string) => {
									if (collection.startsWith('directus_')) {
										const action = scope.split('.')[1];
										return collection.substring(9) + '.' + action;
									}

									return `${collection}.${scope}`;
								});
							}

							return scope;
						})
						.flat();
				}

				if (flow.options['type'] === 'filter') {
					const handler: FilterHandler = (payload, meta, context) =>
						this.executeFlow(
							flow,
							{ payload, ...meta },
							{
								accountability: context['accountability'],
								database: context['database'],
								getSchema: context['schema'] ? () => context['schema'] : getSchema,
							}
						);

					events.forEach((event) => emitter.onFilter(event, handler));

					this.triggerHandlers.push({
						id: flow.id,
						events: events.map((event) => ({ type: 'filter', name: event, handler })),
					});
				} else if (flow.options['type'] === 'action') {
					const handler: ActionHandler = (meta, context) =>
						this.executeFlow(flow, meta, {
							accountability: context['accountability'],
							database: getDatabase(),
							getSchema: context['schema'] ? () => context['schema'] : getSchema,
						});

					events.forEach((event) => emitter.onAction(event, handler));

					this.triggerHandlers.push({
						id: flow.id,
						events: events.map((event) => ({ type: 'action', name: event, handler })),
					});
				}
			} else if (flow.trigger === 'schedule') {
				if (validate(flow.options['cron'])) {
					const task = schedule(flow.options['cron'], async () => {
						try {
							await this.executeFlow(flow);
						} catch (error: any) {
							logger.error(error);
						}
					});

					this.triggerHandlers.push({ id: flow.id, events: [{ type: flow.trigger, task }] });
				} else {
					logger.warn(`Couldn't register cron trigger. Provided cron is invalid: ${flow.options['cron']}`);
				}
			} else if (flow.trigger === 'operation') {
				const handler = (data: unknown, context: Record<string, unknown>) => this.executeFlow(flow, data, context);

				this.operationFlowHandlers[flow.id] = handler;
			} else if (flow.trigger === 'webhook') {
				const method = flow.options?.['method'] ?? 'GET';

				const handler = async (data: unknown, context: Record<string, unknown>) => {
					let cacheEnabled = true;

					if (method === 'GET') {
						cacheEnabled = flow.options['cacheEnabled'] !== false;
					}

					if (flow.options['async']) {
						this.executeFlow(flow, data, context);
						return { result: undefined, cacheEnabled };
					} else {
						return { result: await this.executeFlow(flow, data, context), cacheEnabled };
					}
				};

				// Default return to $last for webhooks
				flow.options['return'] = flow.options['return'] ?? '$last';

				this.webhookFlowHandlers[`${method}-${flow.id}`] = handler;
			} else if (flow.trigger === 'manual') {
				const handler = async (data: unknown, context: Record<string, unknown>) => ({
					result: await this._runManualFlow(flow, data, context),
					cacheEnabled: true,
				});

				// Default return to $last for manual
				flow.options['return'] = '$last';

				this.webhookFlowHandlers[`POST-${flow.id}`] = handler;
			}
		}

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		for (const trigger of this.triggerHandlers) {
			trigger.events.forEach((event) => {
				switch (event.type) {
					case 'filter':
						emitter.offFilter(event.name, event.handler);
						break;
					case 'action':
						emitter.offAction(event.name, event.handler);
						break;
					case 'schedule':
						event.task.stop();
						break;
				}
			});
		}

		this.triggerHandlers = [];
		this.operationFlowHandlers = {};
		this.webhookFlowHandlers = {};

		this.isLoaded = false;
	}

	private async _runManualFlow(flow: Flow, data: unknown, context: Record<string, unknown>): Promise<unknown> {
		const accountability = context['accountability'] as Accountability | null | undefined;
		const schema = context['schema'] as SchemaOverview;

		if (!accountability || !accountability.user) {
			throw new exceptions.ForbiddenException();
		}

		const enabledCollections = (flow.options?.['collections'] as string[] | undefined) ?? [];
		const body = ((data as Record<string, any> | undefined)?.['body'] ?? {}) as Record<string, any>;
		const targetCollection = body['collection'] as string | undefined;
		const keys = body['keys'];

		if (!targetCollection) {
			logger.warn(`Manual trigger requires "collection" to be specified in the payload`);
			throw new exceptions.ForbiddenException();
		}

		if (enabledCollections.length === 0) {
			logger.warn(`There is no collections configured for this manual trigger`);
			throw new exceptions.ForbiddenException();
		}

		if (!enabledCollections.includes(targetCollection)) {
			logger.warn(`Specified collection must be one of: ${enabledCollections.join(', ')}.`);
			throw new exceptions.ForbiddenException();
		}

		const authorizationService = new AuthorizationService({ accountability, knex: getDatabase(), schema });

		if (Array.isArray(keys) && keys.length > 0) {
			await authorizationService.checkAccess('read', targetCollection, keys);
		} else if (flow.options?.['requireSelection'] === false) {
			if (accountability.admin !== true) {
				const hasCollectionRead = accountability.permissions?.some(
					(perm) => perm.collection === targetCollection && perm.action === 'read'
				);

				if (!hasCollectionRead) throw new exceptions.ForbiddenException();
			}
		} else {
			throw new exceptions.ForbiddenException();
		}

		if (flow.options['async']) {
			this.executeFlow(flow, data, context);
			return undefined;
		}

		return this.executeFlow(flow, data, context);
	}

	private async executeFlow(flow: Flow, data: unknown = null, context: Record<string, unknown> = {}): Promise<unknown> {
		const database = (context['database'] as Knex) ?? getDatabase();
		const schema = (context['schema'] as SchemaOverview) ?? (await getSchema({ database }));

		const keyedData: Record<string, unknown> = {
			[TRIGGER_KEY]: data,
			[LAST_KEY]: data,
			[ACCOUNTABILITY_KEY]: context?.['accountability'] ?? null,
			[ENV_KEY]: pick(env, env['FLOWS_ENV_ALLOW_LIST'] ? toArray(env['FLOWS_ENV_ALLOW_LIST']) : []),
		};

		let nextOperation = flow.operation;
		let lastOperationStatus: 'resolve' | 'reject' | 'unknown' = 'unknown';

		const steps: Step[] = [];
		const confinedRedactionValues: string[] = [];
		const confinedReferenceKeys = new Set<string>();

		while (nextOperation !== null) {
			const { successor, data, status, options, redaction } = await this.executeOperation(
				nextOperation,
				keyedData,
				context
			);

			keyedData[nextOperation.key] = data;
			keyedData[LAST_KEY] = data;
			lastOperationStatus = status;
			steps.push({ operation: nextOperation!.id, key: nextOperation.key, status, options });

			if (redaction !== undefined) {
				confinedRedactionValues.push(...redaction.values);
				for (const key of redaction.keys) confinedReferenceKeys.add(key);
			}

			nextOperation = successor;
		}

		if (flow.accountability !== null) {
			const activityService = new ActivityService({
				knex: database,
				schema: schema,
			});

			const accountability = context?.['accountability'] as Accountability | undefined;

			const activity = await activityService.createOne({
				action: Action.RUN,
				user: accountability?.user ?? null,
				collection: 'directus_flows',
				ip: accountability?.ip ?? null,
				user_agent: accountability?.userAgent ?? null,
				origin: accountability?.origin ?? null,
				item: flow.id,
			});

			if (flow.accountability === 'all') {
				const revisionsService = new RevisionsService({
					knex: database,
					schema: schema,
				});

				await revisionsService.createOne({
					activity: activity,
					collection: 'directus_flows',
					item: flow.id,
					data: buildRevisionData(steps, keyedData, confinedRedactionValues, confinedReferenceKeys),
				});
			}
		}

		if (flow.trigger === 'event' && flow.options['type'] === 'filter' && lastOperationStatus === 'reject') {
			throw keyedData[LAST_KEY];
		}

		if (flow.options['return'] === '$all') {
			return keyedData;
		} else if (flow.options['return']) {
			return get(keyedData, flow.options['return']);
		}

		return undefined;
	}

	private async executeOperation(
		operation: Operation,
		keyedData: Record<string, unknown>,
		context: Record<string, unknown> = {}
	): Promise<{
		successor: Operation | null;
		status: 'resolve' | 'reject' | 'unknown';
		data: unknown;
		options: Record<string, any> | null;
		redaction?: { values: string[]; keys: string[] };
	}> {
		const handler = this.operations.get(operation.type);
		const isConfined = this.confinedOperations.has(operation.type);

		// A type in both registries, or a duplicated confined type, is ambiguous and
		// runs neither path. Rejecting with a sanitized message keeps the operator from
		// being silently routed to one of two operations.
		if (handler !== undefined && isConfined) {
			logger.warn(`Operation type "${operation.type}" is declared by both an inherited and a confined extension`);
			return {
				successor: operation.reject,
				status: 'reject',
				data: { message: 'the operation could not be resolved' },
				options: null,
			};
		}

		if (isConfined) {
			const descriptor = this.confinedOperations.get(operation.type);

			if (!descriptor) {
				logger.warn(`Confined operation type "${operation.type}" is ambiguous`);
				return {
					successor: operation.reject,
					status: 'reject',
					data: { message: 'the operation could not be resolved' },
					options: null,
				};
			}

			return this.executeConfinedOperation(operation, descriptor, keyedData, context);
		}

		if (handler === undefined) {
			logger.warn(`Couldn't find operation ${operation.type}`);
			return { successor: null, status: 'unknown', data: null, options: null };
		}

		const options = applyOptionsData(operation.options, keyedData);

		try {
			let result = await handler(options, {
				services,
				exceptions: { ...exceptions, ...sharedExceptions },
				env,
				database: getDatabase(),
				logger,
				getSchema,
				data: keyedData,
				accountability: null,
				...context,
			});

			// Validate that the operations result is serializable and thus catching the error inside the flow execution
			JSON.stringify(result ?? null);

			// JSON structures don't allow for undefined values, so we need to replace them with null
			// Otherwise the applyOptionsData function will not work correctly on the next operation
			if (typeof result === 'object' && result !== null) {
				result = mapValuesDeep(result, (_, value) => (value === undefined ? null : value));
			}

			return { successor: operation.resolve, status: 'resolve', data: result ?? null, options };
		} catch (error) {
			let data;

			if (error instanceof BaseException) {
				data = { message: error.message, code: error.code, extensions: error.extensions, status: error.status };
			} else if (error instanceof Error) {
				data = { message: error.message };
			} else if (typeof error === 'string') {
				// If the error is a JSON string, parse it and use that as the error data
				data = isValidJSON(error) ? parseJSON(error) : error;
			} else {
				// If error is plain object, use this as the error data and otherwise fallback to null
				data = error ?? null;
			}

			return {
				successor: operation.reject,
				status: 'reject',
				data,
				options,
			};
		}
	}

	/**
	 * Runs a confined operation through its descriptor. The resolved clear options are
	 * recorded as the step options, the same shape an inherited operation records, and
	 * the returned redaction values plus the declared reference keys scrub the secrets
	 * from the revision. The guest receives only `$last` and the handle-substituted
	 * options, never the full flow data bag.
	 */
	private async executeConfinedOperation(
		operation: Operation,
		descriptor: ConfinedOperationDescriptor,
		keyedData: Record<string, unknown>,
		context: Record<string, unknown>
	): Promise<{
		successor: Operation | null;
		status: 'resolve' | 'reject';
		data: unknown;
		options: Record<string, any> | null;
		redaction: { values: string[]; keys: string[] };
	}> {
		const options = applyOptionsData(operation.options, keyedData);
		const accountability = (context['accountability'] as Accountability | null | undefined) ?? null;

		const result = await descriptor.run({
			operationId: operation.id,
			options,
			input: keyedData[LAST_KEY],
			accountability,
		});

		const redaction = { values: result.redactionValues, keys: descriptor.referenceKeys };

		if (result.outcome.ok) {
			return {
				successor: operation.resolve,
				status: 'resolve',
				data: result.outcome.value ?? null,
				options,
				redaction,
			};
		}

		return {
			successor: operation.reject,
			status: 'reject',
			data: { message: result.outcome.error.message, code: result.outcome.error.code },
			options,
			redaction,
		};
	}
}
