import {
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	CONFINED_RUNTIME,
	HYBRID_EXTENSION_TYPES,
	JAVASCRIPT_FILE_EXTS,
	NESTED_EXTENSION_TYPES,
} from '@cairncms/constants';
import * as sharedExceptions from '@cairncms/exceptions';
import type {
	ActionHandler,
	ApiExtension,
	BundleExtension,
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
import { rollup } from 'rollup';
import getDatabase from './database/index.js';
import emitter, { Emitter } from './emitter.js';
import env from './env.js';
import * as exceptions from './exceptions/index.js';
import { getFlowManager, type ConfinedOperationDescriptor } from './flows.js';
import { runConfinedOperation, type ConfinedOperationRequest } from './extensions/confined/operation.js';
import { runConfinedEndpoint } from './extensions/confined/endpoint.js';
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
import { describePosture } from './extensions/confined/sandbox-hardening.js';
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

type ExtensionDiagnostic = {
	name: string;
	type: ExtensionType | null;
	local: boolean;
	version?: string;
	entries?: { name: string; type: string }[];
	status: 'loaded' | 'failed' | 'discovered';
	reason?: SanitizedExtensionError;
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

// The literal route grammar a confined endpoint name must fit before it becomes an
// Express mount: a lowercase npm-style name, optionally scoped, with no pattern
// metacharacters (:, *, ?, +, parentheses) and no case variants.
const CONFINED_ENDPOINT_ROUTE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

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
			if (diagnostic.entries) copy.entries = diagnostic.entries.map((entry) => ({ ...entry }));
			if (diagnostic.reason) copy.reason = { ...diagnostic.reason };

			return copy;
		});
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
				if (verdict.optionDelivery !== undefined) entry.optionDelivery = verdict.optionDelivery;

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

		const operations = [...this.confinedEligible].filter(([extension]) => extension.type === 'operation');

		const counts = new Map<string, number>();
		for (const [extension] of operations) counts.set(extension.name, (counts.get(extension.name) ?? 0) + 1);

		const flowManager = getFlowManager();

		for (const [extension, eligible] of operations) {
			if ((counts.get(extension.name) ?? 0) > 1) {
				// Mark the id ambiguous in the flow manager too, so a flow referencing it
				// takes the sanitized reject path rather than the missing-operation path.
				flowManager.markConfinedOperationAmbiguous(extension.name);

				this.recordFailed(extension, {
					code: 'ambiguous-operation',
					detail: 'a confined operation id is declared more than once',
				});

				continue;
			}

			if (eligible.entrySource === undefined) {
				this.recordFailed(extension, {
					code: VALIDATION_INCOMPLETE,
					detail: 'the confined operation entry is unavailable',
				});

				continue;
			}

			flowManager.addConfinedOperation(extension.name, this.buildConfinedDescriptor(extension, eligible, runtime));
			this.recordLoaded(extension);
		}
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
		extension: Extension,
		eligible: ConfinedEligibleEntry,
		runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig }
	): ConfinedOperationDescriptor {
		const deps = this.confinedRunnerDeps(runtime);

		return {
			referenceKeys: Object.keys(eligible.optionDelivery ?? {}),
			run: (params) => {
				const request: ConfinedOperationRequest = {
					extensionId: extension.name,
					contributionId: extension.name,
					operationId: params.operationId,
					entrySource: eligible.entrySource!,
					capabilities: eligible.capabilities ?? {},
					options: params.options,
					input: params.input,
					accountability: params.accountability,
				};

				if (eligible.optionDelivery !== undefined) request.optionDelivery = eligible.optionDelivery;

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

			this.endpointRouter.use(`/${extension.name}`, this.buildConfinedEndpointHandler(extension, eligible, runtime));
			this.registeredEndpointRoutes.add(extension.name);
			this.recordLoaded(extension);
		}
	}

	private buildConfinedEndpointHandler(
		extension: Extension,
		eligible: ConfinedEligibleEntry,
		runtime: { supervisor: ConfinedSupervisor; config: SandboxConfig }
	): express.RequestHandler {
		const deps = this.confinedRunnerDeps(runtime);

		return async (req, res, next) => {
			try {
				const result = await runConfinedEndpoint(
					{
						extensionId: extension.name,
						contributionId: extension.name,
						entrySource: eligible.entrySource!,
						capabilities: eligible.capabilities ?? {},
						method: req.method,
						path: req.path,
						query: req.query,
						body: req.body,
						accountability: req.accountability ?? null,
					},
					deps
				);

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
		this.confinedRuntimeDeps = {};
		this.confinedRuntimeUnavailable = false;
		this.confinedRuntime = undefined;
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
		this.registerConfinedOperations();
		await this.registerBundles();
		// After every inherited registration, so the collision check sees every
		// inherited route, bundle entries included.
		this.registerConfinedEndpoints();

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

			return output[0].code;
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
			const depRegex = new RegExp(`${escapeRegExp(dep.replace(/\//g, '_'))}\\.[0-9a-f]{8}\\.entry\\.js`);
			const depName = appDir.find((file) => depRegex.test(file));

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
