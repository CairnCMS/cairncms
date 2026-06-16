import {
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	CONFINED_RUNTIME,
	hasSafeEventSegments,
	HYBRID_EXTENSION_TYPES,
	JAVASCRIPT_FILE_EXTS,
	NESTED_EXTENSION_TYPES,
} from '@cairncms/constants';
import * as sharedExceptions from '@cairncms/exceptions';
import type {
	Accountability,
	ActionHandler,
	ApiExtension,
	BundleExtension,
	ConfinedHookEvents,
	ConfinedOptionDelivery,
	ExtensionCapabilities,
	EmbedHandler,
	EndpointConfig,
	Extension,
	ExtensionInfo,
	ExtensionType,
	FilterHandler,
	HookConfig,
	HybridExtension,
	InitHandler,
	NestedExtensionType,
	OperationApiConfig,
	ScheduleHandler,
} from '@cairncms/types';
import { isIn, isTypeIn, pluralize } from '@cairncms/utils';
import {
	ensureExtensionDirs,
	type ExtensionDiscoveryFailure,
	generateExtensionsEntrypoint,
	getLocalExtensions,
	getPackageExtensions,
	pathToRelativeUrl,
	resolvePackage,
	resolvePackageExtensions,
} from '@cairncms/utils/node';
import aliasDefault from '@rollup/plugin-alias';
import nodeResolveDefault from '@rollup/plugin-node-resolve';
import virtualDefault from '@rollup/plugin-virtual';
import chokidar, { FSWatcher } from 'chokidar';
import express, { Router } from 'express';
import { clone, debounce, escapeRegExp } from 'lodash-es';
import { schedule, validate } from 'node-cron';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { rollup, type OutputChunk } from 'rollup';
import getDatabase from './database/index.js';
import emitter, { Emitter } from './emitter.js';
import env from './env.js';
import * as exceptions from './exceptions/index.js';
import { getFlowManager, type ConfinedOperationDescriptor } from './flows.js';
import { runConfinedOperation, type ConfinedOperationRequest } from './extensions/confined/operation.js';
import { runConfinedEndpoint, type ConfinedEndpointRequest } from './extensions/confined/endpoint.js';
import { runConfinedActionHook, runConfinedFilterHook, type ConfinedHookRequest } from './extensions/confined/hook.js';
import type { ConfinedLogEntry } from './extensions/confined/broker.js';
import type { ConfinedHostDispatcher, ConfinedInvocation } from './extensions/confined/types.js';
import { confinedItemsService } from './extensions/confined/items-service.js';
import type { SandboxConfig } from './extensions/confined/sandbox-limits.js';
import { getAxios } from './request/index.js';
import logger from './logger.js';
import * as services from './services/index.js';
import type { EventHandler } from './types/index.js';
import {
	gateConfinedExtension,
	VALIDATION_INCOMPLETE,
	type ConfinedEligibleEntry,
	type ConfinedGateVerdict,
	type ConfinedLoadGateDeps,
} from './extensions/confined/load-gate.js';
import { resolveConfinedRuntime, type ConfinedSupervisor } from './extensions/confined/supervisor.js';
import { describePosture, type SandboxPosture } from './extensions/confined/sandbox-hardening.js';
import getModuleDefault from './utils/get-module-default.js';
import { filterServerExtensions } from './utils/filter-server-extensions.js';
import { sanitizeExtensionError, type SanitizedExtensionError } from './utils/sanitize-extension-error.js';
import { getSchema } from './utils/get-schema.js';
import { JobQueue } from './utils/job-queue.js';
import { Url } from './utils/url.js';

// Rollup plugins ship with CJS-style `default` exports but are typed as the module itself;
// these casts unwrap to the real functions.
const virtual = virtualDefault as unknown as typeof virtualDefault.default;
const alias = aliasDefault as unknown as typeof aliasDefault.default;
const nodeResolve = nodeResolveDefault as unknown as typeof nodeResolveDefault.default;

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let extensionManager: ExtensionManager | undefined;

export function getExtensionManager(): ExtensionManager {
	if (extensionManager) {
		return extensionManager;
	}

	extensionManager = new ExtensionManager();

	return extensionManager;
}

type BundleConfig = {
	endpoints: { name: string; config: EndpointConfig }[];
	hooks: { name: string; config: HookConfig }[];
	operations: { name: string; config: OperationApiConfig }[];
};

// A confined bundle's server entries register independently, so each carries its own
// status and reason. An app entry, or an inherited bundle's entry, has no per-entry
// status.
type ExtensionDiagnosticEntry = {
	name: string;
	type: string;
	status?: 'loaded' | 'failed';
	reason?: SanitizedExtensionError;
	capabilities?: ExtensionCapabilities;
};

type ExtensionDiagnostic = {
	name: string;
	type: ExtensionType | null;
	local: boolean;
	version?: string;
	entries?: ExtensionDiagnosticEntry[];
	// `partial` is a confined bundle whose server entries did not all register the same
	// way: some loaded, some failed.
	status: 'loaded' | 'failed' | 'discovered' | 'partial';
	reason?: SanitizedExtensionError;
	// A confined top-level extension carries its gate-validated declared capabilities here.
	// A confined bundle carries them per entry instead, so the bundle row has none.
	capabilities?: ExtensionCapabilities;
};

// The global confined-runtime metadata on the diagnostics response. `not-required` means no
// confined extension this load (the sandbox env is never resolved), `available` carries the
// resolved posture, `unavailable` means a confined extension was present but the runtime did
// not resolve.
type ConfinedPostureSummary = {
	mode: SandboxPosture['mode'];
	decision: SandboxPosture['decision'];
	applied: SandboxPosture['applied'];
	missing: SandboxPosture['missing'];
	cgroupMechanic: SandboxPosture['cgroupMechanic'];
};

type ConfinedRuntimeMeta = {
	state: 'not-required' | 'available' | 'unavailable';
	posture: ConfinedPostureSummary | null;
};

type AppExtensions = string | null;

type ApiExtensions = { path: string }[];

type Options = {
	schedule: boolean;
	watch: boolean;
};

const defaultOptions: Options = {
	schedule: true,
	watch: env['EXTENSIONS_AUTO_RELOAD'],
};

const RELOAD_DEBOUNCE_MS = 250;

// The per-contribution facts a confined runner binding needs, identical for a
// top-level extension and one server entry of a bundle. A bundle entry adds the
// `type:name` key so the engine selects it from the shared CairnBundle artifact.
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

// Matches an app shared-dependency entry chunk by name, e.g. "vue" ->
// "vue.ev7YwI6S.entry.js". The hash is Vite's URL-safe [hash], base64url with
// mixed case plus - and _, not lowercase hex, so the charset must allow
// [A-Za-z0-9_-] or no shared dep ever resolves and the app bundler re-bundles them.
export function findSharedDepAsset(dep: string, assetFiles: string[]): string | undefined {
	const depRegex = new RegExp(`^${escapeRegExp(dep.replace(/\//g, '_'))}\\.[A-Za-z0-9_-]+\\.entry\\.js$`);
	return assetFiles.find((file) => depRegex.test(file));
}

export class ExtensionManager {
	private isLoaded = false;
	private options: Options;

	private extensions: Extension[] = [];
	private serverExtensions: Extension[] = [];

	// Confined extensions that passed the load gate this load, for the confined
	// bindings. Keyed by the discovered object itself, because a name is not a safe
	// identity: two same-name packages can both be discovered. An entry carries the
	// probed entry bytes for an operation and the gate-validated capabilities (per
	// bundle server entry, never merged), so the binding executes exactly what the
	// gate scanned and probed under exactly what was validated. Transient by design:
	// recomputed on every load, never persisted, and carrying no public diagnostic
	// row until registration.
	private confinedEligible = new Map<Extension, ConfinedEligibleEntry>();

	// Test seam for the gate's scanner, probe, and limits dependencies. Overrides
	// the production-resolved deps below, so a test can drive the gate directly.
	private confinedGateDeps: ConfinedLoadGateDeps = {};

	// The gate config and probe resolved from the confined runtime this load, when
	// confined extensions are present. The probe runs under the operator's resolved
	// posture, not the baseline default singleton.
	private confinedRuntimeDeps: ConfinedLoadGateDeps = {};

	// Set when the confined runtime could not be resolved this load. Every declared
	// confined extension is failed closed and the gate is skipped, while inherited
	// extensions load untouched.
	private confinedRuntimeUnavailable = false;

	// The resolved confined runtime this load, retained so confined operation bindings
	// run under the posture-validated supervisor rather than a default singleton.
	private confinedRuntime: { supervisor: ConfinedSupervisor; config: SandboxConfig } | undefined;

	// The resolved OS hardening posture this load, retained for the operator diagnostics
	// metadata. Present only when a confined extension is present and the runtime resolved.
	private confinedRuntimePosture: SandboxPosture | undefined;

	private appExtensions: AppExtensions = null;
	private appExtensionChunks: Map<string, string>;
	private apiExtensions: ApiExtensions = [];
	private diagnostics: ExtensionDiagnostic[] = [];
	private appBundleFailure: SanitizedExtensionError | null = null;

	private apiEmitter: Emitter;
	private hookEvents: EventHandler[] = [];
	private endpointRouter: Router;

	// Every endpoint route mounted this load, inherited and confined, so a confined
	// endpoint can fail closed on a collision instead of relying on Express order.
	private registeredEndpointRoutes = new Set<string>();

	// Confined operation ids that may not register this load, computed once across
	// every confined operation contributor (top-level and bundle entries) plus the
	// inherited operations, so a duplicate or inherited collision fails every
	// contributor at registration rather than one being recorded loaded and then
	// turned ambiguous by a later one. Keyed id to the sanitized failure reason.
	private confinedOperationBlocks = new Map<string, SanitizedExtensionError>();
	private hookEmbedsHead: string[] = [];
	private hookEmbedsBody: string[] = [];

	private reloadQueue: JobQueue;
	private watcher: FSWatcher | null = null;

	// Paired with the watcher's awaitWriteFinish: a multi-file build (app.js + api.js) collapses into one reload.
	private reloadDebounced = debounce(() => this.reload(), RELOAD_DEBOUNCE_MS);

	constructor() {
		this.options = defaultOptions;

		this.apiEmitter = new Emitter();
		this.endpointRouter = Router();

		this.reloadQueue = new JobQueue();

		this.appExtensionChunks = new Map();
	}

	public async initialize(options: Partial<Options> = {}): Promise<void> {
		this.options = {
			...defaultOptions,
			...options,
		};

		const wasWatcherInitialized = this.watcher !== null;

		if (this.options.watch && !wasWatcherInitialized) {
			this.initializeWatcher();
		} else if (!this.options.watch && wasWatcherInitialized) {
			await this.closeWatcher();
		}

		if (!this.isLoaded) {
			await this.load();

			this.logExtensionStatus();
		}

		if (this.options.watch && !wasWatcherInitialized) {
			this.updateWatchedExtensions(this.extensions);
		}
	}

	public reload(): void {
		this.reloadQueue.enqueue(async () => {
			if (this.isLoaded) {
				logger.info('Reloading extensions');

				const prevExtensions = clone(this.extensions);

				await this.unload();
				await this.load();

				const added = this.extensions.filter(
					(extension) => !prevExtensions.some((prevExtension) => extension.path === prevExtension.path)
				);

				const removed = prevExtensions.filter(
					(prevExtension) => !this.extensions.some((extension) => prevExtension.path === extension.path)
				);

				this.updateWatchedExtensions(added, removed);

				const addedExtensions = added.map((extension) => extension.name);
				const removedExtensions = removed.map((extension) => extension.name);

				if (addedExtensions.length > 0) {
					logger.info(`Added extensions: ${addedExtensions.join(', ')}`);
				}

				if (removedExtensions.length > 0) {
					logger.info(`Removed extensions: ${removedExtensions.join(', ')}`);
				}

				this.logExtensionStatus();
			} else {
				logger.warn('Extensions have to be loaded before they can be reloaded');
			}
		});
	}

	public getDiagnostics(): ExtensionDiagnostic[] {
		return this.diagnostics.map((diagnostic) => {
			const copy: ExtensionDiagnostic = {
				name: diagnostic.name,
				type: diagnostic.type,
				local: diagnostic.local,
				status: diagnostic.status,
			};

			if (diagnostic.version) copy.version = diagnostic.version;

			if (diagnostic.entries) {
				copy.entries = diagnostic.entries.map((entry) => ({
					...entry,
					...(entry.reason && { reason: { ...entry.reason } }),
					...(entry.capabilities && { capabilities: structuredClone(entry.capabilities) }),
				}));
			}

			if (diagnostic.reason) copy.reason = { ...diagnostic.reason };
			if (diagnostic.capabilities) copy.capabilities = structuredClone(diagnostic.capabilities);

			return copy;
		});
	}

	/**
	 * The global confined-runtime metadata for the diagnostics response. Derived from the
	 * load state, never by resolving the runtime, so a plain-only load (no confined
	 * extension) stays `not-required` and never touches the sandbox env.
	 */
	public getConfinedRuntimeMeta(): ConfinedRuntimeMeta {
		if (this.confinedRuntime !== undefined && this.confinedRuntimePosture !== undefined) {
			const posture = this.confinedRuntimePosture;

			return {
				state: 'available',
				posture: {
					mode: posture.mode,
					decision: posture.decision,
					applied: [...posture.applied],
					missing: [...posture.missing],
					cgroupMechanic: posture.cgroupMechanic,
				},
			};
		}

		if (this.confinedRuntimeUnavailable) return { state: 'unavailable', posture: null };

		return { state: 'not-required', posture: null };
	}

	private logExtensionStatus(): void {
		const loaded = this.diagnostics.filter((diagnostic) => diagnostic.status === 'loaded');

		if (loaded.length > 0) {
			logger.info(`Loaded extensions: ${loaded.map((diagnostic) => diagnostic.name).join(', ')}`);
		}

		const discovered = this.diagnostics.filter((diagnostic) => diagnostic.status === 'discovered');

		if (discovered.length > 0) {
			logger.info(`Discovered app extensions: ${discovered.map((diagnostic) => diagnostic.name).join(', ')}`);
		}

		const failed = this.diagnostics.filter((diagnostic) => diagnostic.status === 'failed');

		if (failed.length > 0) {
			logger.warn(
				`Failed to load extensions: ${failed
					.map((diagnostic) => `${diagnostic.name} (${diagnostic.reason?.code ?? 'UNKNOWN'})`)
					.join(', ')}`
			);
		}

		const partial = this.diagnostics.filter((diagnostic) => diagnostic.status === 'partial');

		if (partial.length > 0) {
			logger.warn(
				`Partially loaded confined bundles: ${partial
					.map((diagnostic) => {
						const failedEntries = (diagnostic.entries ?? [])
							.filter((entry) => entry.status === 'failed')
							.map((entry) => `${entry.type}:${entry.name} (${entry.reason?.code ?? 'UNKNOWN'})`)
							.join(', ');

						return `${diagnostic.name} [${failedEntries}]`;
					})
					.join('; ')}`
			);
		}
	}

	private recordLoaded(extension: Extension): void {
		const diagnostic: ExtensionDiagnostic = {
			name: extension.name,
			type: extension.type,
			local: extension.local,
			status: 'loaded',
		};

		if (extension.version) diagnostic.version = extension.version;

		if (extension.type === 'bundle') {
			diagnostic.entries = extension.entries.map((entry) => ({ name: entry.name, type: entry.type }));
		}

		const eligible = this.confinedEligible.get(extension);
		if (eligible?.capabilities !== undefined) diagnostic.capabilities = eligible.capabilities;

		this.diagnostics.push(diagnostic);
	}

	private recordFailed(extension: Extension, reason: SanitizedExtensionError): void {
		const diagnostic: ExtensionDiagnostic = {
			name: extension.name,
			type: extension.type,
			local: extension.local,
			status: 'failed',
			reason,
		};

		if (extension.version) diagnostic.version = extension.version;

		if (extension.type === 'bundle') {
			diagnostic.entries = extension.entries.map((entry) => ({ name: entry.name, type: entry.type }));
		}

		const eligible = this.confinedEligible.get(extension);
		if (eligible?.capabilities !== undefined) diagnostic.capabilities = eligible.capabilities;

		this.diagnostics.push(diagnostic);
	}

	/**
	 * Resolves the confined runtime once per load, only when a declared confined
	 * extension is present, so a malformed sandbox env never affects a load with no
	 * confined extensions. A resolution failure fails every confined extension closed
	 * and leaves inherited extensions to load. On success the resolved config and a
	 * probe bound to the posture-validated supervisor are injected into the gate, and
	 * the resolved posture is logged once.
	 */
	private async prepareConfinedRuntime(): Promise<void> {
		const confined = this.extensions.filter((extension) => extension.runtime === CONFINED_RUNTIME);

		if (confined.length === 0) return;

		const resolution = await resolveConfinedRuntime();

		if (!resolution.ok) {
			const reason: SanitizedExtensionError = { code: VALIDATION_INCOMPLETE, detail: resolution.error.message };
			for (const extension of confined) this.recordFailed(extension, reason);
			this.confinedRuntimeUnavailable = true;
			return;
		}

		this.confinedRuntimeDeps = {
			config: resolution.config,
			probe: (invocation) => resolution.supervisor.probeLoad(invocation),
		};

		this.confinedRuntime = { supervisor: resolution.supervisor, config: resolution.config };
		this.confinedRuntimePosture = resolution.posture;

		logger.info(describePosture(resolution.posture));
	}

	/**
	 * Validates each declared-confined extension before it may run confined. A
	 * failure refuses the extension into diagnostics, never downgrading it to full
	 * authority. A pass joins the private eligible set with no public diagnostic
	 * row, since a confined extension is rowed at registration. Sequential by
	 * design: probes spawn confined children, and one at a time stays inside the
	 * supervisor's capacity gate, so a probe can never be refused busy by a
	 * sibling probe.
	 */
	private async gateConfinedExtensions(): Promise<void> {
		// The runtime resolution already failed every confined extension closed.
		if (this.confinedRuntimeUnavailable) return;

		const deps: ConfinedLoadGateDeps = { ...this.confinedRuntimeDeps, ...this.confinedGateDeps };

		for (const extension of this.extensions) {
			if (extension.runtime !== CONFINED_RUNTIME) continue;

			let verdict: ConfinedGateVerdict;

			try {
				verdict = await gateConfinedExtension(extension, deps);
			} catch {
				// A gate failure fails this extension closed. It must never abort the
				// loader and take every other extension down with it.
				verdict = {
					ok: false,
					error: { code: VALIDATION_INCOMPLETE, detail: 'confined validation could not complete' },
				};
			}

			if (verdict.ok) {
				const entry: ConfinedEligibleEntry = {};
				if (verdict.entrySource !== undefined) entry.entrySource = verdict.entrySource;
				if (verdict.capabilities !== undefined) entry.capabilities = verdict.capabilities;
				if (verdict.entryCapabilities !== undefined) entry.entryCapabilities = verdict.entryCapabilities;
				if (verdict.entryEvents !== undefined) entry.entryEvents = verdict.entryEvents;
				if (verdict.optionDelivery !== undefined) entry.optionDelivery = verdict.optionDelivery;
				// The fail-open boundary: a per-entry reference declaration dropped here would
				// reach the guest as a clear configured value, so it is copied explicitly.
				if (verdict.entryOptionDelivery !== undefined) entry.entryOptionDelivery = verdict.entryOptionDelivery;
				if (verdict.events !== undefined) entry.events = verdict.events;

				this.confinedEligible.set(extension, entry);
			} else {
				this.recordFailed(extension, verdict.error);
			}
		}
	}

	/**
	 * Registers the eligible confined operations into the flow manager without
	 * importing any server artifact. A contribution id declared by more than one
	 * eligible operation is ambiguous: every one is failed in diagnostics and none is
	 * registered, so an operator sees the conflict at load rather than at run.
	 */
	private registerConfinedOperations(): void {
		const runtime = this.confinedRuntime;
		if (runtime === undefined) return;

		const flowManager = getFlowManager();

		// Computed once across every confined operation contributor and the inherited
		// operations, before any descriptor is added, so a blocked id never records one
		// contributor loaded and then turns it ambiguous when a later one collides.
		this.confinedOperationBlocks = this.resolveConfinedOperationBlocks(flowManager);

		const operations = [...this.confinedEligible].filter(([extension]) => extension.type === 'operation');

		for (const [extension, eligible] of operations) {
			const block = this.confinedOperationBlocks.get(extension.name);

			if (block !== undefined) {
				// Mark the id ambiguous so a flow referencing it, or its inherited
				// namesake, takes the sanitized reject path and runs neither.
				flowManager.markConfinedOperationAmbiguous(extension.name);
				this.recordFailed(extension, block);
				continue;
			}

			if (eligible.entrySource === undefined) {
				this.recordFailed(extension, {
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

			flowManager.addConfinedOperation(
				extension.name,
				this.buildConfinedDescriptor(binding, eligible.optionDelivery, runtime)
			);

			this.recordLoaded(extension);
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
	private resolveConfinedOperationBlocks(
		flowManager: ReturnType<typeof getFlowManager>
	): Map<string, SanitizedExtensionError> {
		const ids: string[] = [];

		for (const [extension] of this.confinedEligible) {
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
					code: 'operation-collision',
					detail: 'the operation id is declared by an inherited operation',
				});
			} else if ((counts.get(id) ?? 0) > 1) {
				blocked.set(id, {
					code: 'ambiguous-operation',
					detail: 'a confined operation id is declared more than once',
				});
			}
		}

		return blocked;
	}

	private confinedRunnerDeps(runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig }) {
		const { supervisor, config } = runtime;

		return {
			invoke: (invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher) =>
				supervisor.invoke(invocation, dispatcher),
			log: (entry: ConfinedLogEntry) => this.logConfinedEntry(entry),
			getAxios: () => getAxios(),
			itemsService: confinedItemsService,
			brokerLimits: {
				settingsValueBytes: config.sandbox.settingsValueBytes,
				httpResponseBytes: config.sandbox.httpResponseBytes,
				itemsReplyBytes: config.sandbox.itemsReplyBytes,
				templateOutputBytes: config.sandbox.templateOutputBytes,
			},
			runtimeLimits: config.runtime,
		};
	}

	private buildConfinedDescriptor(
		binding: ConfinedBinding,
		optionDelivery: ConfinedOptionDelivery | undefined,
		runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig }
	): ConfinedOperationDescriptor {
		const deps = this.confinedRunnerDeps(runtime);

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
	private registerConfinedEndpoints(): void {
		const runtime = this.confinedRuntime;
		if (runtime === undefined) return;

		const endpoints = [...this.confinedEligible].filter(([extension]) => extension.type === 'endpoint');

		const counts = new Map<string, number>();
		for (const [extension] of endpoints) counts.set(extension.name, (counts.get(extension.name) ?? 0) + 1);

		for (const [extension, eligible] of endpoints) {
			// The name becomes an Express mount, which interprets pattern syntax and
			// matches case-insensitively. Only a lowercase literal grammar mounts, so a
			// name cannot smuggle a parameter or wildcard past the literal collision
			// checks, and the grammar matches the canonical lowercase route key.
			if (!CONFINED_ENDPOINT_ROUTE.test(extension.name)) {
				this.recordFailed(extension, {
					code: 'route-invalid',
					detail: 'the confined endpoint route name is not a safe literal route',
				});

				continue;
			}

			if ((counts.get(extension.name) ?? 0) > 1) {
				this.recordFailed(extension, {
					code: 'ambiguous-endpoint',
					detail: 'a confined endpoint route is declared more than once',
				});

				continue;
			}

			if (this.registeredEndpointRoutes.has(extension.name)) {
				this.recordFailed(extension, {
					code: 'route-collision',
					detail: 'the confined endpoint route is already registered',
				});

				continue;
			}

			if (eligible.entrySource === undefined) {
				this.recordFailed(extension, {
					code: VALIDATION_INCOMPLETE,
					detail: 'the confined endpoint entry is unavailable',
				});

				continue;
			}

			if (eligible.capabilities?.endpoint === undefined) {
				this.recordFailed(extension, {
					code: 'capability-missing',
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

			this.endpointRouter.use(`/${extension.name}`, this.buildConfinedEndpointHandler(binding, runtime));
			this.registeredEndpointRoutes.add(extension.name);
			this.recordLoaded(extension);
		}
	}

	/**
	 * Registers the eligible confined hooks onto the platform emitter without
	 * importing any server artifact, subscribing exactly the manifest-declared
	 * events the probe verified against the entry. A filter failure blocks the
	 * platform action with a sanitized error, because a filter that cannot run
	 * must not be silently skipped. An action failure logs and never blocks.
	 */
	private registerConfinedHooks(): void {
		const runtime = this.confinedRuntime;
		if (runtime === undefined) return;

		const hooks = [...this.confinedEligible].filter(([extension]) => extension.type === 'hook');

		const counts = new Map<string, number>();
		for (const [extension] of hooks) counts.set(extension.name, (counts.get(extension.name) ?? 0) + 1);

		for (const [extension, eligible] of hooks) {
			if ((counts.get(extension.name) ?? 0) > 1) {
				this.recordFailed(extension, {
					code: 'ambiguous-hook',
					detail: 'a confined hook id is declared more than once',
				});

				continue;
			}

			if (eligible.entrySource === undefined || eligible.events === undefined) {
				this.recordFailed(extension, {
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
				this.recordFailed(extension, {
					code: 'event-invalid',
					detail: 'a confined hook event name is not a safe literal event',
				});

				continue;
			}

			const binding: ConfinedBinding = {
				extensionId: extension.name,
				contributionId: extension.name,
				entrySource: eligible.entrySource,
				capabilities: eligible.capabilities ?? {},
			};

			this.subscribeConfinedHook(binding, eligible.events, runtime);
			this.recordLoaded(extension);
		}
	}

	/**
	 * Subscribes one confined hook binding's manifest events onto the platform
	 * emitter. A filter failure blocks the platform action with a sanitized error,
	 * since a filter that cannot run must not be silently skipped. An action failure
	 * logs and never blocks. Handlers join `hookEvents`, so unload unregisters them
	 * the same way it does inherited hooks.
	 */
	private subscribeConfinedHook(
		binding: ConfinedBinding,
		events: ConfinedHookEvents,
		runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig }
	): void {
		const deps = this.confinedRunnerDeps(runtime);

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
			this.hookEvents.push({ type: 'filter', name: event, handler });
		}

		for (const event of events.action ?? []) {
			const handler: ActionHandler = async (meta, context) => {
				const result = await runConfinedActionHook(baseRequest(event, meta, context.accountability ?? null), deps);

				if (!result.ok) {
					logger.warn(`The confined hook "${binding.contributionId}" failed for action "${event}"`);
				}
			};

			emitter.onAction(event, handler);
			this.hookEvents.push({ type: 'action', name: event, handler });
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
	private registerConfinedBundles(): void {
		const runtime = this.confinedRuntime;
		if (runtime === undefined) return;

		const flowManager = getFlowManager();

		for (const [extension, eligible] of this.confinedEligible) {
			if (extension.type !== 'bundle') continue;

			if (eligible.entrySource === undefined) {
				this.recordFailed(extension, {
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

				const outcome = this.registerConfinedBundleEntry(
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

			this.recordBundle(extension, entryStatuses);
		}
	}

	private registerConfinedBundleEntry(
		kind: 'operation' | 'endpoint' | 'hook',
		name: string,
		binding: ConfinedBinding,
		events: ConfinedHookEvents | undefined,
		optionDelivery: ConfinedOptionDelivery | undefined,
		runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig },
		flowManager: ReturnType<typeof getFlowManager>
	): { status: 'loaded' | 'failed'; reason?: SanitizedExtensionError } {
		if (kind === 'operation') {
			const block = this.confinedOperationBlocks.get(name);

			if (block !== undefined) {
				flowManager.markConfinedOperationAmbiguous(name);
				return { status: 'failed', reason: block };
			}

			flowManager.addConfinedOperation(name, this.buildConfinedDescriptor(binding, optionDelivery, runtime));
			return { status: 'loaded' };
		}

		if (kind === 'endpoint') {
			if (!CONFINED_ENDPOINT_ROUTE.test(name)) {
				return {
					status: 'failed',
					reason: { code: 'route-invalid', detail: 'the confined endpoint route name is not a safe literal route' },
				};
			}

			if (this.registeredEndpointRoutes.has(name)) {
				return {
					status: 'failed',
					reason: { code: 'route-collision', detail: 'the confined endpoint route is already registered' },
				};
			}

			if (binding.capabilities.endpoint === undefined) {
				return {
					status: 'failed',
					reason: { code: 'capability-missing', detail: 'the endpoint capability is not declared' },
				};
			}

			this.endpointRouter.use(`/${name}`, this.buildConfinedEndpointHandler(binding, runtime));
			this.registeredEndpointRoutes.add(name);
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
				reason: { code: 'event-invalid', detail: 'a confined hook event name is not a safe literal event' },
			};
		}

		this.subscribeConfinedHook(binding, events, runtime);
		return { status: 'loaded' };
	}

	private recordBundle(extension: BundleExtension, entries: ExtensionDiagnosticEntry[]): void {
		const failed = entries.filter((entry) => entry.status === 'failed').length;
		const loaded = entries.length - failed;

		let status: ExtensionDiagnostic['status'] = 'partial';
		if (failed === 0) status = 'loaded';
		else if (loaded === 0) status = 'failed';

		const diagnostic: ExtensionDiagnostic = {
			name: extension.name,
			type: extension.type,
			local: extension.local,
			status,
			entries,
		};

		if (extension.version) diagnostic.version = extension.version;

		this.diagnostics.push(diagnostic);
	}

	private buildConfinedEndpointHandler(
		binding: ConfinedBinding,
		runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig }
	): express.RequestHandler {
		const deps = this.confinedRunnerDeps(runtime);

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

	private logConfinedEntry(entry: ConfinedLogEntry): void {
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

	private recordAppDiagnostics(): void {
		const appExtensions = this.extensions.filter((extension) => isIn(extension.type, APP_EXTENSION_TYPES));

		for (const extension of appExtensions) {
			const diagnostic: ExtensionDiagnostic = {
				name: extension.name,
				type: extension.type,
				local: extension.local,
				status: 'discovered',
			};

			if (extension.version) diagnostic.version = extension.version;

			this.diagnostics.push(diagnostic);
		}

		if (this.appBundleFailure) {
			this.diagnostics.push({
				name: '(app bundle)',
				type: null,
				local: false,
				status: 'failed',
				reason: this.appBundleFailure,
			});
		}
	}

	public getExtensionsList(type?: ExtensionType) {
		if (type === undefined) {
			return this.extensions.map(mapInfo);
		} else {
			return this.extensions.map(mapInfo).filter((extension) => extension.type === type);
		}

		function mapInfo(extension: Extension): ExtensionInfo {
			const extensionInfo: ExtensionInfo = {
				name: extension.name,
				type: extension.type,
				local: extension.local,
				entries: [],
			};

			if (extension.host) extensionInfo.host = extension.host;
			if (extension.version) extensionInfo.version = extension.version;

			if (extension.type === 'bundle') {
				const bundleExtensionInfo: Omit<BundleExtension, 'entrypoint' | 'path'> = {
					name: extensionInfo.name,
					type: 'bundle',
					local: extensionInfo.local,
					entries: extension.entries.map((entry) => ({
						name: entry.name,
						type: entry.type,
					})) as { name: ExtensionInfo['name']; type: NestedExtensionType }[],
				};

				return bundleExtensionInfo;
			} else {
				return extensionInfo;
			}
		}
	}

	public getExtension(name: string): Extension | undefined {
		return this.extensions.find((extension) => extension.name === name);
	}

	public getAppExtensions(): string | null {
		return this.appExtensions;
	}

	public getAppExtensionChunk(name: string): string | null {
		return this.appExtensionChunks.get(name) ?? null;
	}

	public getEndpointRouter(): Router {
		return this.endpointRouter;
	}

	public getEmbeds() {
		return {
			head: wrapEmbeds('Custom Embed Head', this.hookEmbedsHead),
			body: wrapEmbeds('Custom Embed Body', this.hookEmbedsBody),
		};

		function wrapEmbeds(label: string, content: string[]): string {
			if (content.length === 0) return '';
			return `<!-- Start ${label} -->\n${content.join('\n')}\n<!-- End ${label} -->`;
		}
	}

	private async load(): Promise<void> {
		this.diagnostics = [];
		this.appBundleFailure = null;
		this.extensions = [];
		this.serverExtensions = [];
		this.confinedEligible.clear();
		this.confinedOperationBlocks.clear();
		this.confinedRuntimeDeps = {};
		this.confinedRuntimeUnavailable = false;
		this.confinedRuntime = undefined;
		this.confinedRuntimePosture = undefined;
		this.hookEmbedsHead = [];
		this.hookEmbedsBody = [];

		try {
			await ensureExtensionDirs(env['EXTENSIONS_PATH'], NESTED_EXTENSION_TYPES);

			this.extensions = await this.getExtensions();
		} catch (err: any) {
			const reason = sanitizeExtensionError(err, 'DISCOVERY_FAILED');
			logger.warn(`Couldn't load extensions: ${reason.code} ${reason.detail}`);
			this.diagnostics.push({ name: '(extension discovery)', type: null, local: true, status: 'failed', reason });
		}

		this.serverExtensions = filterServerExtensions(this.extensions);

		await this.prepareConfinedRuntime();
		await this.gateConfinedExtensions();

		await this.registerHooks();
		await this.registerEndpoints();
		await this.registerOperations();
		await this.registerBundles();
		// After every inherited operation source, top-level and bundle, so a confined
		// operation colliding with an inherited one is caught at load rather than read
		// loaded and rejected only at run.
		this.registerConfinedOperations();
		// After every inherited registration, so the collision check sees every
		// inherited route, bundle entries included.
		this.registerConfinedEndpoints();
		this.registerConfinedHooks();
		// Last, so a bundle entry's collision check sees every inherited and top-level
		// confined route and operation already registered.
		this.registerConfinedBundles();

		if (env['SERVE_APP']) {
			this.appExtensions = await this.generateExtensionBundle();
			this.recordAppDiagnostics();
		}

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		this.unregisterApiExtensions();

		this.serverExtensions = [];
		this.confinedEligible.clear();
		this.confinedRuntimeDeps = {};
		this.confinedRuntimeUnavailable = false;
		this.confinedRuntime = undefined;
		this.confinedRuntimePosture = undefined;

		this.apiEmitter.offAll();

		if (env['SERVE_APP']) {
			this.appExtensions = null;
		}

		this.isLoaded = false;
	}

	private initializeWatcher(): void {
		logger.info('Watching extensions for changes...');

		const extensionDirUrl = pathToRelativeUrl(env['EXTENSIONS_PATH']);

		// With SERVE_APP off, Vite owns app extensions, so the watcher tracks only server-relevant entrypoints.
		const serveApp = env['SERVE_APP'];

		const localExtensionUrls = NESTED_EXTENSION_TYPES.flatMap((type) => {
			if (!serveApp && isIn(type, APP_EXTENSION_TYPES)) return [];

			const typeDir = path.posix.join(extensionDirUrl, pluralize(type));

			if (isIn(type, HYBRID_EXTENSION_TYPES)) {
				const apiGlob = path.posix.join(typeDir, '*', `api.{${JAVASCRIPT_FILE_EXTS.join()}}`);

				return serveApp ? [path.posix.join(typeDir, '*', `app.{${JAVASCRIPT_FILE_EXTS.join()}}`), apiGlob] : [apiGlob];
			} else {
				return path.posix.join(typeDir, '*', `index.{${JAVASCRIPT_FILE_EXTS.join()}}`);
			}
		});

		this.watcher = chokidar.watch(
			[path.resolve('package.json'), path.posix.join(extensionDirUrl, '*', 'package.json'), ...localExtensionUrls],
			{
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
			}
		);

		this.watcher
			.on('add', () => this.reloadDebounced())
			.on('change', () => this.reloadDebounced())
			.on('unlink', () => this.reloadDebounced());
	}

	private async closeWatcher(): Promise<void> {
		if (this.watcher) {
			this.reloadDebounced.cancel();

			await this.watcher.close();

			this.watcher = null;
		}
	}

	private updateWatchedExtensions(added: Extension[], removed: Extension[] = []): void {
		if (this.watcher) {
			const nestedLocalTypeDir = (type: string) => path.resolve(env['EXTENSIONS_PATH'], pluralize(type));

			// Package-style local extensions build into dist paths the nested-layout
			// globs never see, so their server-relevant entrypoints are watched
			// per-extension. The globs keep sole ownership of the nested layout:
			// unwatching a path suppresses it in chokidar even where a glob still
			// matches, so a dynamically managed nested entrypoint would lose its
			// reloads permanently after a remove and re-add. App types stay with
			// Vite unless the API serves the app.
			const toPackageExtensionPaths = (extensions: Extension[]) =>
				extensions
					.filter((extension) => env['SERVE_APP'] || !isIn(extension.type, APP_EXTENSION_TYPES))
					.filter(
						(extension) =>
							extension.type === 'bundle' ||
							!extension.local ||
							path.dirname(path.resolve(extension.path)) !== nestedLocalTypeDir(extension.type)
					)
					.flatMap((extension) => {
						if (isTypeIn(extension, HYBRID_EXTENSION_TYPES) || extension.type === 'bundle') {
							const apiPath = path.resolve(extension.path, extension.entrypoint.api);

							return env['SERVE_APP'] ? [path.resolve(extension.path, extension.entrypoint.app), apiPath] : [apiPath];
						}

						return path.resolve(extension.path, extension.entrypoint);
					});

			const addedPackageExtensionPaths = toPackageExtensionPaths(added);
			const removedPackageExtensionPaths = toPackageExtensionPaths(removed);

			this.watcher.add(addedPackageExtensionPaths);
			this.watcher.unwatch(removedPackageExtensionPaths);
		}
	}

	private async getExtensions(): Promise<Extension[]> {
		const onDiscoveryFailure = (failure: ExtensionDiscoveryFailure) => {
			const reason = sanitizeExtensionError(failure.error, 'MANIFEST_INVALID');

			this.diagnostics.push({
				name: failure.name,
				type: null,
				local: failure.local,
				status: 'failed',
				reason,
			});
		};

		const packageExtensions = await getPackageExtensions(env['PACKAGE_FILE_LOCATION'], onDiscoveryFailure);

		const localPackageExtensions = await resolvePackageExtensions(
			env['EXTENSIONS_PATH'],
			undefined,
			onDiscoveryFailure
		);

		let localExtensions: Extension[] = [];

		try {
			localExtensions = await getLocalExtensions(env['EXTENSIONS_PATH']);
		} catch (error) {
			const reason = sanitizeExtensionError(error, 'DISCOVERY_FAILED');

			this.diagnostics.push({
				name: '(local extensions)',
				type: null,
				local: true,
				status: 'failed',
				reason,
			});
		}

		return [...packageExtensions, ...localPackageExtensions, ...localExtensions].filter(
			(extension) => env['SERVE_APP'] || APP_EXTENSION_TYPES.includes(extension.type as any) === false
		);
	}

	private async generateExtensionBundle(): Promise<string | null> {
		this.appExtensionChunks.clear();

		const sharedDepsMapping = await this.getSharedDepsMapping(APP_SHARED_DEPS);

		const internalImports = Object.entries(sharedDepsMapping).map(([name, path]) => ({
			find: name,
			replacement: path,
		}));

		const entrypoint = generateExtensionsEntrypoint(this.extensions);

		try {
			const bundle = await rollup({
				input: 'entry',
				external: Object.values(sharedDepsMapping),
				makeAbsoluteExternalsRelative: false,
				plugins: [virtual({ entry: entrypoint }), alias({ entries: internalImports }), nodeResolve({ browser: true })],
			});

			const { output } = await bundle.generate({ format: 'es', compact: true });

			for (const out of output) {
				if (out.type === 'chunk') {
					this.appExtensionChunks.set(out.fileName, out.code);
				}
			}

			await bundle.close();

			// Dynamic imports in the entrypoint make rollup emit multiple chunks, so the
			// entry is not reliably output[0]. Select it explicitly, and treat a missing
			// entry as a build failure (through the catch) rather than returning null,
			// which would 404 /extensions/sources/index.js with no diagnostic.
			const entryChunk = output.find((out): out is OutputChunk => out.type === 'chunk' && out.isEntry);

			if (!entryChunk) {
				throw new Error('app extension bundle produced no entry chunk');
			}

			return entryChunk.code;
		} catch (error: any) {
			this.appBundleFailure = sanitizeExtensionError(error, 'BUNDLE_BUILD_FAILED');
			logger.warn(`Couldn't bundle app extensions: ${this.appBundleFailure.code} ${this.appBundleFailure.detail}`);
		}

		return null;
	}

	private async getSharedDepsMapping(deps: string[]): Promise<Record<string, string>> {
		const appDir = await readdir(path.join(resolvePackage('@cairncms/app', __dirname), 'dist', 'assets'));

		const depsMapping: Record<string, string> = {};

		for (const dep of deps) {
			const depName = findSharedDepAsset(dep, appDir);

			if (depName) {
				const depUrl = new Url(env['PUBLIC_URL']).addPath('admin', 'assets', depName);

				depsMapping[dep] = depUrl.toString({ rootRelative: true });
			} else {
				logger.warn(`Couldn't find shared extension dependency "${dep}"`);
			}
		}

		return depsMapping;
	}

	private async registerHooks(): Promise<void> {
		const hooks = this.serverExtensions.filter((extension): extension is ApiExtension => extension.type === 'hook');

		for (const hook of hooks) {
			try {
				const hookPath = path.resolve(hook.path, hook.entrypoint);

				const hookInstance: HookConfig | { default: HookConfig } = await import(
					`./${pathToRelativeUrl(hookPath, __dirname)}?t=${Date.now()}`
				);

				const config = getModuleDefault(hookInstance);

				this.registerHook(config);

				this.apiExtensions.push({ path: hookPath });

				this.recordLoaded(hook);
			} catch (error: any) {
				const reason = sanitizeExtensionError(error, 'REGISTRATION_FAILED');
				logger.warn(`Couldn't register hook "${hook.name}": ${reason.code} ${reason.detail}`);
				this.recordFailed(hook, reason);
			}
		}
	}

	private async registerEndpoints(): Promise<void> {
		const endpoints = this.serverExtensions.filter(
			(extension): extension is ApiExtension => extension.type === 'endpoint'
		);

		for (const endpoint of endpoints) {
			try {
				const endpointPath = path.resolve(endpoint.path, endpoint.entrypoint);

				const endpointInstance: EndpointConfig | { default: EndpointConfig } = await import(
					`./${pathToRelativeUrl(endpointPath, __dirname)}?t=${Date.now()}`
				);

				const config = getModuleDefault(endpointInstance);

				this.registerEndpoint(config, endpoint.name);

				this.apiExtensions.push({ path: endpointPath });

				this.recordLoaded(endpoint);
			} catch (error: any) {
				const reason = sanitizeExtensionError(error, 'REGISTRATION_FAILED');
				logger.warn(`Couldn't register endpoint "${endpoint.name}": ${reason.code} ${reason.detail}`);
				this.recordFailed(endpoint, reason);
			}
		}
	}

	private async registerOperations(): Promise<void> {
		const internalOperations = await readdir(path.join(__dirname, 'operations'));

		for (const operation of internalOperations) {
			const operationInstance: OperationApiConfig | { default: OperationApiConfig } = await import(
				`./operations/${operation}/index.js`
			);

			const config = getModuleDefault(operationInstance);

			this.registerOperation(config);
		}

		const operations = this.serverExtensions.filter(
			(extension): extension is HybridExtension => extension.type === 'operation'
		);

		for (const operation of operations) {
			try {
				const operationPath = path.resolve(operation.path, operation.entrypoint.api!);

				const operationInstance: OperationApiConfig | { default: OperationApiConfig } = await import(
					`./${pathToRelativeUrl(operationPath, __dirname)}?t=${Date.now()}`
				);

				const config = getModuleDefault(operationInstance);

				this.registerOperation(config);

				this.apiExtensions.push({ path: operationPath });

				this.recordLoaded(operation);
			} catch (error: any) {
				const reason = sanitizeExtensionError(error, 'REGISTRATION_FAILED');
				logger.warn(`Couldn't register operation "${operation.name}": ${reason.code} ${reason.detail}`);
				this.recordFailed(operation, reason);
			}
		}
	}

	private async registerBundles(): Promise<void> {
		const bundles = this.serverExtensions.filter(
			(extension): extension is BundleExtension => extension.type === 'bundle'
		);

		for (const bundle of bundles) {
			try {
				const bundlePath = path.resolve(bundle.path, bundle.entrypoint.api);

				const bundleInstances: BundleConfig | { default: BundleConfig } = await import(
					`./${pathToRelativeUrl(bundlePath, __dirname)}?t=${Date.now()}`
				);

				const configs = getModuleDefault(bundleInstances);

				for (const { config } of configs.hooks) {
					this.registerHook(config);
				}

				for (const { config, name } of configs.endpoints) {
					this.registerEndpoint(config, name);
				}

				for (const { config } of configs.operations) {
					this.registerOperation(config);
				}

				this.apiExtensions.push({ path: bundlePath });

				this.recordLoaded(bundle);
			} catch (error: any) {
				const reason = sanitizeExtensionError(error, 'REGISTRATION_FAILED');
				logger.warn(`Couldn't register bundle "${bundle.name}": ${reason.code} ${reason.detail}`);
				this.recordFailed(bundle, reason);
			}
		}
	}

	private registerHook(register: HookConfig): void {
		const registerFunctions = {
			filter: (event: string, handler: FilterHandler) => {
				emitter.onFilter(event, handler);

				this.hookEvents.push({
					type: 'filter',
					name: event,
					handler,
				});
			},
			action: (event: string, handler: ActionHandler) => {
				emitter.onAction(event, handler);

				this.hookEvents.push({
					type: 'action',
					name: event,
					handler,
				});
			},
			init: (event: string, handler: InitHandler) => {
				emitter.onInit(event, handler);

				this.hookEvents.push({
					type: 'init',
					name: event,
					handler,
				});
			},
			schedule: (cron: string, handler: ScheduleHandler) => {
				if (validate(cron)) {
					const task = schedule(cron, async () => {
						if (this.options.schedule) {
							try {
								await handler();
							} catch (error: any) {
								logger.error(error);
							}
						}
					});

					this.hookEvents.push({
						type: 'schedule',
						task,
					});
				} else {
					logger.warn(`Couldn't register cron hook. Provided cron is invalid: ${cron}`);
				}
			},
			embed: (position: 'head' | 'body', code: string | EmbedHandler) => {
				const content = typeof code === 'function' ? code() : code;

				if (content.trim().length === 0) {
					logger.warn(`Couldn't register embed hook. Provided code is empty!`);
					return;
				}

				if (position === 'head') {
					this.hookEmbedsHead.push(content);
				}

				if (position === 'body') {
					this.hookEmbedsBody.push(content);
				}
			},
		};

		register(registerFunctions, {
			services,
			exceptions: { ...exceptions, ...sharedExceptions },
			env,
			database: getDatabase(),
			emitter: this.apiEmitter,
			logger,
			getSchema,
		});
	}

	private registerEndpoint(config: EndpointConfig, name: string): void {
		const register = typeof config === 'function' ? config : config.handler;
		const routeName = typeof config === 'function' ? name : config.id;

		const scopedRouter = express.Router();
		this.endpointRouter.use(`/${routeName}`, scopedRouter);
		// Lowercased, because the router matches case-insensitively: a confined route
		// must collide with an inherited case variant, not shadow it.
		this.registeredEndpointRoutes.add(routeName.toLowerCase());

		register(scopedRouter, {
			services,
			exceptions: { ...exceptions, ...sharedExceptions },
			env,
			database: getDatabase(),
			emitter: this.apiEmitter,
			logger,
			getSchema,
		});
	}

	private registerOperation(config: OperationApiConfig): void {
		const flowManager = getFlowManager();

		flowManager.addOperation(config.id, config.handler);
	}

	private unregisterApiExtensions(): void {
		for (const event of this.hookEvents) {
			switch (event.type) {
				case 'filter':
					emitter.offFilter(event.name, event.handler);
					break;
				case 'action':
					emitter.offAction(event.name, event.handler);
					break;
				case 'init':
					emitter.offInit(event.name, event.handler);
					break;
				case 'schedule':
					event.task.stop();
					break;
			}
		}

		this.hookEvents = [];

		this.endpointRouter.stack = [];
		this.registeredEndpointRoutes.clear();

		const flowManager = getFlowManager();

		flowManager.clearOperations();
		flowManager.clearConfinedOperations();

		for (const apiExtension of this.apiExtensions) {
			try {
				delete require.cache[require.resolve(apiExtension.path)];
			} catch (error: any) {
				// A removed extension has no cached entry to evict, and require.resolve throws on its missing path.
				if (error?.code !== 'MODULE_NOT_FOUND') throw error;
			}
		}

		this.apiExtensions = [];
	}
}
