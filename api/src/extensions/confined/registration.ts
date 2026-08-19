import type {
	Accountability,
	ActionHandler,
	BundleExtension,
	ConfinedHookEvents,
	ConfinedOptionDelivery,
	Extension,
	ExtensionCapabilities,
	FilterHandler,
} from '@cairncms/types';
import { RESERVED_EVENT_NAMESPACE_ERROR, hasSafeEventSegments, isReservedEventNamespace } from '@cairncms/constants';
import express, { type Router } from 'express';
import getDatabase from '../../database/index.js';
import emitter from '../../emitter.js';
import * as exceptions from '../../exceptions/index.js';
import { getFlowManager, type ConfinedOperationDescriptor } from '../../flows.js';
import logger from '../../logger.js';
import { getAxios } from '../../request/index.js';
import { readGlobalSettings } from '../../services/extension-settings-store.js';
import { registerOperationOptionSecrets } from '../../services/operation-option-secrets.js';
import type { EventHandler } from '../../types/index.js';
import type { SanitizedExtensionError } from '../../utils/sanitize-extension-error.js';
import type { ExtensionDiagnosticEntry } from '../diagnostics.js';
import type { ConfinedLogEntry } from './broker.js';
import { runConfinedEndpoint, type ConfinedEndpointRequest } from './endpoint.js';
import { runConfinedActionHook, runConfinedFilterHook, type ConfinedHookRequest } from './hook.js';
import { confinedItemsService } from './items-service.js';
import type { ConfinedEligibleEntry } from './load-gate.js';
import { VALIDATION_INCOMPLETE } from './load-gate.js';
import { runConfinedOperation, type ConfinedOperationRequest } from './operation.js';
import type { SandboxConfig } from './sandbox-limits.js';
import { buildConfinedSettingsAccess } from './settings-access.js';
import type { ConfinedSupervisor } from './supervisor.js';
import type { ConfinedHostDispatcher, ConfinedInvocation } from './types.js';

export type ConfinedRuntimeHandle = { supervisor: ConfinedSupervisor; config: SandboxConfig };

type ConfinedBinding = {
	extensionId: string;
	contributionId: string;
	entrySource: string;
	capabilities: ExtensionCapabilities;
	bundleEntryKey?: string;
};

// The literal route grammar a confined endpoint name must fit before it becomes an
// Express mount: a lowercase npm-style name, optionally scoped, with no pattern
// metacharacters (:, *, ?, +, parentheses) and no case variants.
const CONFINED_ENDPOINT_ROUTE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// The manager owns the durable state; the registrar reads it lazily through this view so a
// field the manager reassigns (the runtime handle, the hook-event list) is never held stale.
// The registrar imports nothing back from extensions.ts.
export interface ConfinedRegistrarView {
	runtime(): ConfinedRuntimeHandle | undefined;
	eligible(): Map<Extension, ConfinedEligibleEntry>;
	endpointRouter(): Router;
	registeredEndpointRoutes(): Set<string>;
	hookEvents(): EventHandler[];
	getSettingsOwner(subject: string): Extension | undefined;
	recordLoaded(extension: Extension): void;
	recordFailed(extension: Extension, reason: SanitizedExtensionError): void;
	recordBundle(extension: BundleExtension, entries: ExtensionDiagnosticEntry[]): void;
}

/**
 * Registers eligible confined server entries onto the platform without importing any server
 * artifact. `operationBlocks` is registration scratch computed once at the start of
 * `registerOperations` and read by `registerBundles`, both gated on the runtime, so a bundle
 * entry's operation collision check sees every top-level confined operation's verdict. The
 * four register methods must run in the manager's load order.
 */
export class ConfinedRegistrar {
	private operationBlocks = new Map<string, SanitizedExtensionError>();

	constructor(private view: ConfinedRegistrarView) {}

	registerOperations(): void {
		const runtime = this.view.runtime();
		if (runtime === undefined) return;

		const flowManager = getFlowManager();

		// Computed once across every confined operation contributor and the inherited
		// operations, before any descriptor is added, so a blocked id never records one
		// contributor loaded and then turns it ambiguous when a later one collides.
		this.operationBlocks = this.resolveOperationBlocks(flowManager);

		const operations = [...this.view.eligible()].filter(([extension]) => extension.type === 'operation');

		for (const [extension, eligible] of operations) {
			const block = this.operationBlocks.get(extension.name);

			if (block !== undefined) {
				// Mark the id ambiguous so a flow referencing it, or its inherited
				// namesake, takes the sanitized reject path and runs neither.
				flowManager.markConfinedOperationAmbiguous(extension.name);
				this.view.recordFailed(extension, block);
				continue;
			}

			if (eligible.entrySource === undefined) {
				this.view.recordFailed(extension, {
					code: VALIDATION_INCOMPLETE,
					detail: 'the confined operation entry is unavailable',
				});

				continue;
			}

			const binding: ConfinedBinding = {
				extensionId: extension.name,
				contributionId: extension.name,
				entrySource: eligible.entrySource,
				capabilities: eligible.capabilities ?? {},
			};

			flowManager.addConfinedOperation(extension.name, this.buildDescriptor(binding, eligible.optionDelivery, runtime));

			registerOperationOptionSecrets(extension.name, Object.keys(eligible.optionDelivery ?? {}));

			this.view.recordLoaded(extension);
		}
	}

	/**
	 * Computes the confined operation ids that may not register this load. An id is
	 * blocked when more than one confined contributor declares it (top-level
	 * operations and bundle operation entries share the operation namespace) or when
	 * it collides with an inherited operation, whether a built-in, a top-level
	 * operation, or one contributed by an inherited bundle. A blocked id runs neither
	 * contribution, so the duplicate reads ambiguous and the inherited collision reads
	 * as a collision.
	 */
	private resolveOperationBlocks(flowManager: ReturnType<typeof getFlowManager>): Map<string, SanitizedExtensionError> {
		const ids: string[] = [];

		for (const [extension] of this.view.eligible()) {
			if (extension.type === 'operation') {
				ids.push(extension.name);
			} else if (extension.type === 'bundle') {
				for (const entry of extension.entries) {
					if (entry.type === 'operation') ids.push(entry.name);
				}
			}
		}

		const counts = new Map<string, number>();
		for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);

		const blocked = new Map<string, SanitizedExtensionError>();

		for (const id of new Set(ids)) {
			if (flowManager.hasOperation(id)) {
				blocked.set(id, {
					code: 'OPERATION_COLLISION',
					detail: 'the operation id is declared by an inherited operation',
				});
			} else if ((counts.get(id) ?? 0) > 1) {
				blocked.set(id, {
					code: 'AMBIGUOUS_OPERATION',
					detail: 'a confined operation id is declared more than once',
				});
			}
		}

		return blocked;
	}

	private runnerDeps(runtime: ConfinedRuntimeHandle) {
		const { supervisor, config } = runtime;

		return {
			invoke: (invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher) =>
				supervisor.invoke(invocation, dispatcher),
			log: (entry: ConfinedLogEntry) => this.logEntry(entry),
			getAxios: () => getAxios(),
			itemsService: confinedItemsService,
			settingsAccess: (subject: string) =>
				buildConfinedSettingsAccess({
					subject,
					declaration: this.view.getSettingsOwner(subject)?.settings,
					readRows: (signal) => readGlobalSettings(getDatabase(), subject, signal),
				}),
			brokerLimits: {
				settingsValueBytes: config.sandbox.settingsValueBytes,
				httpResponseBytes: config.sandbox.httpResponseBytes,
				itemsReplyBytes: config.sandbox.itemsReplyBytes,
				templateOutputBytes: config.sandbox.templateOutputBytes,
			},
			runtimeLimits: config.runtime,
		};
	}

	private buildDescriptor(
		binding: ConfinedBinding,
		optionDelivery: ConfinedOptionDelivery | undefined,
		runtime: ConfinedRuntimeHandle
	): ConfinedOperationDescriptor {
		const deps = this.runnerDeps(runtime);

		return {
			referenceKeys: Object.keys(optionDelivery ?? {}),
			run: (params) => {
				const request: ConfinedOperationRequest = {
					extensionId: binding.extensionId,
					contributionId: binding.contributionId,
					operationId: params.operationId,
					entrySource: binding.entrySource,
					capabilities: binding.capabilities,
					options: params.options,
					input: params.input,
					accountability: params.accountability,
				};

				if (binding.bundleEntryKey !== undefined) request.bundleEntryKey = binding.bundleEntryKey;
				if (optionDelivery !== undefined) request.optionDelivery = optionDelivery;

				return runConfinedOperation(request, deps);
			},
		};
	}

	/**
	 * Registers the eligible confined endpoints onto the endpoint router without
	 * importing any server artifact. A route already taken by an inherited endpoint
	 * or declared by more than one confined endpoint fails closed in diagnostics,
	 * and an endpoint without the declared endpoint capability never mounts.
	 */
	registerEndpoints(): void {
		const runtime = this.view.runtime();
		if (runtime === undefined) return;

		const endpoints = [...this.view.eligible()].filter(([extension]) => extension.type === 'endpoint');

		const counts = new Map<string, number>();
		for (const [extension] of endpoints) counts.set(extension.name, (counts.get(extension.name) ?? 0) + 1);

		for (const [extension, eligible] of endpoints) {
			// The name becomes an Express mount, which interprets pattern syntax and
			// matches case-insensitively. Only a lowercase literal grammar mounts, so a
			// name cannot smuggle a parameter or wildcard past the literal collision
			// checks, and the grammar matches the canonical lowercase route key.
			if (!CONFINED_ENDPOINT_ROUTE.test(extension.name)) {
				this.view.recordFailed(extension, {
					code: 'ROUTE_INVALID',
					detail: 'the confined endpoint route name is not a safe literal route',
				});

				continue;
			}

			if ((counts.get(extension.name) ?? 0) > 1) {
				this.view.recordFailed(extension, {
					code: 'AMBIGUOUS_ENDPOINT',
					detail: 'a confined endpoint route is declared more than once',
				});

				continue;
			}

			if (this.view.registeredEndpointRoutes().has(extension.name)) {
				this.view.recordFailed(extension, {
					code: 'ROUTE_COLLISION',
					detail: 'the confined endpoint route is already registered',
				});

				continue;
			}

			if (eligible.entrySource === undefined) {
				this.view.recordFailed(extension, {
					code: VALIDATION_INCOMPLETE,
					detail: 'the confined endpoint entry is unavailable',
				});

				continue;
			}

			if (eligible.capabilities?.endpoint === undefined) {
				this.view.recordFailed(extension, {
					code: 'CAPABILITY_MISSING',
					detail: 'the endpoint capability is not declared',
				});

				continue;
			}

			const binding: ConfinedBinding = {
				extensionId: extension.name,
				contributionId: extension.name,
				entrySource: eligible.entrySource,
				capabilities: eligible.capabilities ?? {},
			};

			this.view.endpointRouter().use(`/${extension.name}`, this.buildEndpointHandler(binding, runtime));
			this.view.registeredEndpointRoutes().add(extension.name);
			this.view.recordLoaded(extension);
		}
	}

	/**
	 * Registers the eligible confined hooks onto the platform emitter without
	 * importing any server artifact, subscribing exactly the manifest-declared
	 * events the probe verified against the entry. A filter failure blocks the
	 * platform action with a sanitized error, because a filter that cannot run
	 * must not be silently skipped. An action failure logs and never blocks.
	 */
	registerHooks(): void {
		const runtime = this.view.runtime();
		if (runtime === undefined) return;

		const hooks = [...this.view.eligible()].filter(([extension]) => extension.type === 'hook');

		const counts = new Map<string, number>();
		for (const [extension] of hooks) counts.set(extension.name, (counts.get(extension.name) ?? 0) + 1);

		for (const [extension, eligible] of hooks) {
			if ((counts.get(extension.name) ?? 0) > 1) {
				this.view.recordFailed(extension, {
					code: 'AMBIGUOUS_HOOK',
					detail: 'a confined hook id is declared more than once',
				});

				continue;
			}

			if (eligible.entrySource === undefined || eligible.events === undefined) {
				this.view.recordFailed(extension, {
					code: VALIDATION_INCOMPLETE,
					detail: 'the confined hook entry is unavailable',
				});

				continue;
			}

			const declaredEvents = [...(eligible.events.filter ?? []), ...(eligible.events.action ?? [])];

			// The manifest schema already refuses these, so this is defense in depth:
			// a reserved-segment name reaching the emitter would pollute shared globals
			// and alias unrelated events, so the whole hook fails before any subscription.
			if (!declaredEvents.every(hasSafeEventSegments)) {
				this.view.recordFailed(extension, {
					code: 'EVENT_INVALID',
					detail: 'a confined hook event name is not a safe literal event',
				});

				continue;
			}

			if (declaredEvents.some(isReservedEventNamespace)) {
				this.view.recordFailed(extension, {
					code: 'EVENT_INVALID',
					detail: RESERVED_EVENT_NAMESPACE_ERROR,
				});

				continue;
			}

			const binding: ConfinedBinding = {
				extensionId: extension.name,
				contributionId: extension.name,
				entrySource: eligible.entrySource,
				capabilities: eligible.capabilities ?? {},
			};

			this.subscribeHook(binding, eligible.events, runtime);
			this.view.recordLoaded(extension);
		}
	}

	/**
	 * Subscribes one confined hook binding's manifest events onto the platform
	 * emitter. A filter failure blocks the platform action with a sanitized error,
	 * since a filter that cannot run must not be silently skipped. An action failure
	 * logs and never blocks. Handlers join `hookEvents`, so unload unregisters them
	 * the same way it does inherited hooks.
	 */
	private subscribeHook(binding: ConfinedBinding, events: ConfinedHookEvents, runtime: ConfinedRuntimeHandle): void {
		const deps = this.runnerDeps(runtime);

		const baseRequest = (
			event: string,
			meta: Record<string, unknown>,
			accountability: Accountability | null
		): ConfinedHookRequest => {
			const request: ConfinedHookRequest = {
				extensionId: binding.extensionId,
				contributionId: binding.contributionId,
				entrySource: binding.entrySource,
				capabilities: binding.capabilities,
				event,
				meta,
				accountability,
			};

			if (binding.bundleEntryKey !== undefined) request.bundleEntryKey = binding.bundleEntryKey;

			return request;
		};

		for (const event of events.filter ?? []) {
			const handler: FilterHandler = async (payload, meta, context) => {
				const result = await runConfinedFilterHook(
					{ ...baseRequest(event, meta, context.accountability ?? null), payload },
					deps
				);

				if (!result.ok) throw new Error(`the confined hook "${binding.contributionId}" failed`);

				return result.unchanged ? undefined : result.payload;
			};

			emitter.onFilter(event, handler);
			this.view.hookEvents().push({ type: 'filter', name: event, handler });
		}

		for (const event of events.action ?? []) {
			const handler: ActionHandler = async (meta, context) => {
				const result = await runConfinedActionHook(baseRequest(event, meta, context.accountability ?? null), deps);

				if (!result.ok) {
					logger.warn(`The confined hook "${binding.contributionId}" failed for action "${event}"`);
				}
			};

			emitter.onAction(event, handler);
			this.view.hookEvents().push({ type: 'action', name: event, handler });
		}
	}

	/**
	 * Registers every confined bundle's server entries from its one shared artifact,
	 * each through the same runner as its top-level counterpart, selecting that
	 * entry's own capabilities and events by `type:name`. An entry's registration
	 * identity may collide (an operation id, an endpoint route): that entry fails on
	 * its own while its siblings register, and the bundle's diagnostic carries each
	 * entry's status. The shared artifact being unavailable fails the whole bundle.
	 * Runs after the inherited and top-level confined registrations, so the route and
	 * operation collision checks see everything already mounted.
	 */
	registerBundles(): void {
		const runtime = this.view.runtime();
		if (runtime === undefined) return;

		const flowManager = getFlowManager();

		for (const [extension, eligible] of this.view.eligible()) {
			if (extension.type !== 'bundle') continue;

			if (eligible.entrySource === undefined) {
				this.view.recordFailed(extension, {
					code: VALIDATION_INCOMPLETE,
					detail: 'the confined bundle entry is unavailable',
				});

				continue;
			}

			const entryStatuses: ExtensionDiagnosticEntry[] = [];

			for (const entry of extension.entries) {
				const kind = entry.type;
				if (kind !== 'operation' && kind !== 'endpoint' && kind !== 'hook') continue;

				const key = `${kind}:${entry.name}`;

				const binding: ConfinedBinding = {
					extensionId: extension.name,
					contributionId: entry.name,
					entrySource: eligible.entrySource,
					capabilities: eligible.entryCapabilities?.[key] ?? {},
					bundleEntryKey: key,
				};

				const outcome = this.registerBundleEntry(
					kind,
					entry.name,
					binding,
					eligible.entryEvents?.[key],
					eligible.entryOptionDelivery?.[key],
					runtime,
					flowManager
				);

				entryStatuses.push({
					name: entry.name,
					type: kind,
					status: outcome.status,
					...(outcome.reason && { reason: outcome.reason }),
					...(eligible.entryCapabilities?.[key] && { capabilities: eligible.entryCapabilities[key] }),
				});
			}

			this.view.recordBundle(extension, entryStatuses);
		}
	}

	private registerBundleEntry(
		kind: 'operation' | 'endpoint' | 'hook',
		name: string,
		binding: ConfinedBinding,
		events: ConfinedHookEvents | undefined,
		optionDelivery: ConfinedOptionDelivery | undefined,
		runtime: ConfinedRuntimeHandle,
		flowManager: ReturnType<typeof getFlowManager>
	): { status: 'loaded' | 'failed'; reason?: SanitizedExtensionError } {
		if (kind === 'operation') {
			const block = this.operationBlocks.get(name);

			if (block !== undefined) {
				flowManager.markConfinedOperationAmbiguous(name);
				return { status: 'failed', reason: block };
			}

			flowManager.addConfinedOperation(name, this.buildDescriptor(binding, optionDelivery, runtime));
			registerOperationOptionSecrets(name, Object.keys(optionDelivery ?? {}));
			return { status: 'loaded' };
		}

		if (kind === 'endpoint') {
			if (!CONFINED_ENDPOINT_ROUTE.test(name)) {
				return {
					status: 'failed',
					reason: { code: 'ROUTE_INVALID', detail: 'the confined endpoint route name is not a safe literal route' },
				};
			}

			if (this.view.registeredEndpointRoutes().has(name)) {
				return {
					status: 'failed',
					reason: { code: 'ROUTE_COLLISION', detail: 'the confined endpoint route is already registered' },
				};
			}

			if (binding.capabilities.endpoint === undefined) {
				return {
					status: 'failed',
					reason: { code: 'CAPABILITY_MISSING', detail: 'the endpoint capability is not declared' },
				};
			}

			this.view.endpointRouter().use(`/${name}`, this.buildEndpointHandler(binding, runtime));
			this.view.registeredEndpointRoutes().add(name);
			return { status: 'loaded' };
		}

		if (events === undefined) {
			return {
				status: 'failed',
				reason: { code: VALIDATION_INCOMPLETE, detail: 'the confined hook entry events are unavailable' },
			};
		}

		const declaredEvents = [...(events.filter ?? []), ...(events.action ?? [])];

		if (!declaredEvents.every(hasSafeEventSegments)) {
			return {
				status: 'failed',
				reason: { code: 'EVENT_INVALID', detail: 'a confined hook event name is not a safe literal event' },
			};
		}

		if (declaredEvents.some(isReservedEventNamespace)) {
			return {
				status: 'failed',
				reason: { code: 'EVENT_INVALID', detail: RESERVED_EVENT_NAMESPACE_ERROR },
			};
		}

		this.subscribeHook(binding, events, runtime);
		return { status: 'loaded' };
	}

	private buildEndpointHandler(binding: ConfinedBinding, runtime: ConfinedRuntimeHandle): express.RequestHandler {
		const deps = this.runnerDeps(runtime);

		return async (req, res, next) => {
			try {
				const request: ConfinedEndpointRequest = {
					extensionId: binding.extensionId,
					contributionId: binding.contributionId,
					entrySource: binding.entrySource,
					capabilities: binding.capabilities,
					method: req.method,
					path: req.path,
					query: req.query,
					body: req.body,
					accountability: req.accountability ?? null,
				};

				if (binding.bundleEntryKey !== undefined) request.bundleEntryKey = binding.bundleEntryKey;

				const result = await runConfinedEndpoint(request, deps);

				if (result.ok) {
					res.status(result.status);

					if (req.method === 'HEAD') {
						res.end();
						return;
					}

					res.json(result.body);
					return;
				}

				switch (result.failure) {
					case 'unauthenticated':
						next(new exceptions.InvalidCredentialsException());
						return;
					case 'denied':
						next(new exceptions.ForbiddenException());
						return;
					case 'invalid-request':
						next(new exceptions.InvalidPayloadException('the request is not a valid json endpoint request'));
						return;
					default:
						next(new Error('the confined endpoint failed'));
						return;
				}
			} catch {
				next(new Error('the confined endpoint failed'));
			}
		};
	}

	private logEntry(entry: ConfinedLogEntry): void {
		// The broker redacts the entry before this sink, so the identifiers and the
		// message are safe to write.
		logger[entry.level](
			{
				extensionId: entry.context.extensionId,
				contributionId: entry.context.contributionId,
				operationId: entry.context.operationId,
				meta: entry.meta,
			},
			String(entry.message)
		);
	}
}
