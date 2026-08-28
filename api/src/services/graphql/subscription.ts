import type { Accountability, NestedDeepQuery, Query, SchemaOverview } from '@cairncms/types';
import { getArgumentValues, getVariableValues } from 'graphql';
import type {
	DocumentNode,
	FieldNode,
	FragmentDefinitionNode,
	GraphQLError,
	GraphQLResolveInfo,
	GraphQLSchema,
	OperationDefinitionNode,
	SelectionNode,
} from 'graphql';
import type { RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import type { SocketClient } from '../../websocket/controllers/base.js';
import type { WebSocketEvent } from '../../websocket/messages.js';
import {
	canonicalItemKey,
	type Reservation,
	type Subscription,
	type SubscriptionEvent,
} from '../../websocket/subscriptions.js';
import { resolveTargetService } from '../../websocket/target.js';
import { getEventPayload } from '../../websocket/utils/items.js';
import { isDeleteFeedEligible } from '../../websocket/utils/removal.js';
import type { GraphQLService } from './index.js';

const MUTATED_SUFFIX = '_mutated';

type PullResult = { done: false; event: WebSocketEvent } | { done: true };

export class Rendezvous {
	private closed = false;
	private queued: WebSocketEvent | null = null;
	private delivered = false;
	private acknowledge: (() => void) | null = null;
	private detachAbort: (() => void) | null = null;
	private waiting: ((result: PullResult) => void) | null = null;

	pull(): Promise<PullResult> {
		if (this.delivered) this.settleAcknowledgement();

		if (this.closed) return Promise.resolve({ done: true });

		if (this.queued !== null) {
			const event = this.queued;
			this.queued = null;
			this.delivered = true;
			return Promise.resolve({ done: false, event });
		}

		return new Promise<PullResult>((resolve) => {
			this.waiting = resolve;
		});
	}

	push(event: WebSocketEvent, signal: AbortSignal): Promise<void> {
		if (this.closed || signal.aborted) return Promise.resolve();

		return new Promise<void>((resolve) => {
			this.acknowledge = resolve;
			this.delivered = false;

			const onAbort = () => this.settleAcknowledgement();

			signal.addEventListener('abort', onAbort, { once: true });
			this.detachAbort = () => signal.removeEventListener('abort', onAbort);

			if (this.waiting !== null) {
				const waiting = this.waiting;
				this.waiting = null;
				this.delivered = true;
				waiting({ done: false, event });
			} else {
				this.queued = event;
			}
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.queued = null;
		this.settleAcknowledgement();

		if (this.waiting !== null) {
			const waiting = this.waiting;
			this.waiting = null;
			waiting({ done: true });
		}
	}

	private settleAcknowledgement(): void {
		if (this.acknowledge === null) return;
		this.detachAbort?.();
		this.detachAbort = null;
		this.queued = null;
		this.delivered = false;
		const acknowledge = this.acknowledge;
		this.acknowledge = null;
		acknowledge();
	}
}

export interface SubscriptionOperation {
	readonly client: SocketClient;
	readonly channel: Rendezvous;
	readonly reservation: Reservation;
	loadSchema: () => Promise<SchemaOverview>;
	finalize: () => void;
	retire: () => void;
}

export interface SubscriptionExecutionContext {
	accountability: Accountability | null;
	operation: SubscriptionOperation;
}

export interface SubscriptionTarget {
	collection: string;
	event?: SubscriptionEvent;
	errors?: readonly GraphQLError[];
}

function collectFragments(document: DocumentNode): Record<string, FragmentDefinitionNode> {
	const fragments: Record<string, FragmentDefinitionNode> = {};

	for (const definition of document.definitions) {
		if (definition.kind === 'FragmentDefinition') fragments[definition.name.value] = definition;
	}

	return fragments;
}

function collectRootField(
	selections: readonly SelectionNode[],
	fragments: Record<string, FragmentDefinitionNode>
): FieldNode | null {
	for (const selection of selections) {
		if (selection.kind === 'Field') return selection;

		const nested =
			selection.kind === 'InlineFragment'
				? selection.selectionSet.selections
				: fragments[selection.name.value]?.selectionSet.selections ?? [];

		const found = collectRootField(nested, fragments);
		if (found !== null) return found;
	}

	return null;
}

export function resolveSubscriptionTarget(
	schema: GraphQLSchema,
	operation: OperationDefinitionNode,
	document: DocumentNode,
	variables: Record<string, unknown>
): SubscriptionTarget {
	const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], variables);
	if ('errors' in coerced && coerced.errors !== undefined) return { collection: '', errors: coerced.errors };

	const field = collectRootField(operation.selectionSet.selections, collectFragments(document));
	if (field === null || !field.name.value.endsWith(MUTATED_SUFFIX)) return { collection: '' };

	const fieldDefinition = schema.getSubscriptionType()?.getFields()[field.name.value];
	if (fieldDefinition === undefined) return { collection: '' };

	const collection = field.name.value.slice(0, -MUTATED_SUFFIX.length);
	const args = getArgumentValues(fieldDefinition, field, 'coerced' in coerced ? coerced.coerced : {});
	const event = args['event'];

	return event === 'create' || event === 'update' || event === 'delete' ? { collection, event } : { collection };
}

function collectDataSelections(
	selections: readonly SelectionNode[],
	fragments: GraphQLResolveInfo['fragments']
): readonly SelectionNode[] {
	const collected: SelectionNode[] = [];

	for (const selection of selections) {
		if (selection.kind === 'Field') {
			if (selection.name.value === 'data' && selection.selectionSet?.kind === 'SelectionSet') {
				collected.push(...selection.selectionSet.selections);
			}

			continue;
		}

		const nested =
			selection.kind === 'InlineFragment'
				? selection.selectionSet.selections
				: fragments[selection.name.value]?.selectionSet.selections ?? [];

		collected.push(...collectDataSelections(nested, fragments));
	}

	return collected;
}

function inlineFragments(
	selections: readonly SelectionNode[],
	fragments: GraphQLResolveInfo['fragments']
): SelectionNode[] {
	const inlined: SelectionNode[] = [];

	for (const selection of selections) {
		if (selection.kind === 'FragmentSpread') {
			const fragment = fragments[selection.name.value];
			if (fragment !== undefined) inlined.push(...inlineFragments(fragment.selectionSet.selections, fragments));
			continue;
		}

		if (selection.kind === 'Field' && selection.selectionSet !== undefined) {
			inlined.push({
				...selection,
				selectionSet: {
					...selection.selectionSet,
					selections: inlineFragments(selection.selectionSet.selections, fragments),
				},
			});

			continue;
		}

		if (selection.kind === 'InlineFragment') {
			inlined.push({
				...selection,
				selectionSet: {
					...selection.selectionSet,
					selections: inlineFragments(selection.selectionSet.selections, fragments),
				},
			});

			continue;
		}

		inlined.push(selection);
	}

	return inlined;
}

export interface SubscriptionSelection {
	fields: string[];
	deep?: NestedDeepQuery;
}

export function parseFields(service: GraphQLService, request: GraphQLResolveInfo): SubscriptionSelection {
	const dataSelections: SelectionNode[] = [];

	for (const fieldNode of request.fieldNodes) {
		dataSelections.push(...collectDataSelections(fieldNode.selectionSet?.selections ?? [], request.fragments));
	}

	const inlined = inlineFragments(dataSelections, request.fragments);
	const { fields, deep } = service.getQuery({}, inlined, request.variableValues);

	const selection: SubscriptionSelection = { fields: fields ?? [] };
	if (deep != null) selection.deep = deep;
	return selection;
}

type ActiveEvent =
	| { action: 'delete'; keys: readonly (string | number)[]; index: number }
	| {
			action: 'create' | 'update';
			mutation: Extract<WebSocketEvent, { action: 'create' | 'update' }>;
			keys: readonly (string | number)[];
			index: number;
			accountability: RequestAccountability;
			service: NonNullable<ReturnType<typeof resolveTargetService>>;
			schema: SchemaOverview;
	  };

export function createSubscriptionGenerator(self: GraphQLService, event: string) {
	const collection = event.slice(0, -MUTATED_SUFFIX.length);

	return function subscribe(
		_source: unknown,
		_args: unknown,
		context: SubscriptionExecutionContext,
		request: GraphQLResolveInfo
	): AsyncIterableIterator<Record<string, unknown>> {
		const { operation } = context;

		let selection: SubscriptionSelection;

		try {
			selection = parseFields(self, request);
		} catch (error) {
			operation.finalize();
			throw error;
		}

		let activated = false;
		let active: ActiveEvent | null = null;
		let retired = false;
		let closed = false;

		const readKey = async (
			current: ActiveEvent,
			key: string | number
		): Promise<Record<string, unknown> | undefined> => {
			if (current.action === 'delete') {
				return { [event]: { key, data: null, event: 'delete' } };
			}

			const query: Query = { fields: selection.fields };
			if (selection.deep !== undefined) query.deep = selection.deep;

			const readSubscription: Subscription = {
				client: operation.client,
				collection,
				query,
				item: canonicalItemKey(key),
			};

			try {
				const payload = await getEventPayload(
					current.service,
					readSubscription,
					current.accountability,
					current.schema,
					current.mutation
				);

				const data = payload['data'];
				const item = Array.isArray(data) ? data[0] : data;
				return item === undefined ? undefined : { [event]: { key, data: item, event: current.mutation.action } };
			} catch {
				// Permission narrowing is silent: a subscriber never learns which rows it cannot read.
				return undefined;
			}
		};

		const beginEvent = async (mutation: WebSocketEvent): Promise<void> => {
			const schema = await operation.loadSchema();
			const accountability = await operation.client.auth.snapshotAccountability(schema);
			if (accountability === null) return;

			if (mutation.action === 'delete') {
				if (!isDeleteFeedEligible(collection, accountability, schema)) {
					retired = true;
					return;
				}

				active = { action: 'delete', keys: mutation.keys, index: 0 };
				return;
			}

			const service = resolveTargetService(collection, { schema, accountability });
			if (service === null) return;

			active = {
				action: mutation.action,
				mutation,
				keys: mutation.action === 'create' ? [mutation.key] : mutation.keys,
				index: 0,
				accountability,
				service,
				schema,
			};
		};

		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			async next(): Promise<IteratorResult<Record<string, unknown>>> {
				try {
					if (closed) return { value: undefined, done: true };

					if (!activated) {
						activated = true;
						operation.reservation.activate();
					}

					for (;;) {
						if (active !== null && active.index < active.keys.length) {
							const current = active;
							const value = await readKey(current, current.keys[current.index++]!);
							if (closed) return { value: undefined, done: true };
							if (value === undefined) continue;
							return { value, done: false };
						}

						active = null;

						const pulled = await operation.channel.pull();
						if (closed || pulled.done) return { value: undefined, done: true };

						await beginEvent(pulled.event);
						if (closed) return { value: undefined, done: true };
						if (retired) operation.retire();
					}
				} catch (error) {
					if (closed) return { value: undefined, done: true };
					operation.finalize();
					throw error;
				}
			},
			return(): Promise<IteratorResult<Record<string, unknown>>> {
				closed = true;
				active = null;
				operation.channel.close();
				operation.finalize();
				return Promise.resolve({ value: undefined, done: true });
			},
			throw(error?: unknown): Promise<IteratorResult<Record<string, unknown>>> {
				closed = true;
				active = null;
				operation.channel.close();
				operation.finalize();
				return Promise.reject(error);
			},
		};
	};
}
