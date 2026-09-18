import {
	APP_EXTENSION_TYPES,
	CONFINED_RUNTIME,
	HYBRID_EXTENSION_TYPES,
	JAVASCRIPT_FILE_EXTS,
	NESTED_EXTENSION_TYPES,
} from '@cairncms/constants';
import type {
	ApiExtension,
	BundleExtension,
	EndpointConfig,
	Extension,
	ExtensionInfo,
	ExtensionSettings,
	ExtensionType,
	HookConfig,
	HybridExtension,
	NestedExtensionType,
	OperationApiConfig,
} from '@cairncms/types';
import { isIn, isTypeIn, pluralize } from '@cairncms/utils';
import {
	ensureExtensionDirs,
	type ExtensionDiscoveryFailure,
	getLocalExtensions,
	getPackageExtensions,
	pathToRelativeUrl,
	resolvePackageExtensions,
} from '@cairncms/utils/node';
import chokidar, { FSWatcher } from 'chokidar';
import { Router } from 'express';
import { clone, debounce } from 'lodash-es';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'path';
import getDatabase from './database/index.js';
import emitter, { Emitter } from './emitter.js';
import env from './env.js';
import { getFlowManager } from './flows.js';
import { buildAppExtensionBundle } from './extensions/app-bundle.js';
import { ConfinedRegistrar } from './extensions/confined/registration.js';
import * as diagnosticsLog from './extensions/diagnostics.js';
import type {
	ConfinedRuntimeMeta,
	DiagnosticsView,
	ExtensionDiagnostic,
	ExtensionDiagnosticEntry,
} from './extensions/diagnostics.js';
import { buildExtensionSettingsReader } from './extensions/extension-settings-reader.js';
import {
	registerEndpoint as registerFullAuthorityEndpoint,
	registerHook as registerFullAuthorityHook,
	registerOperation as registerFullAuthorityOperation,
	type FullAuthorityRegistrationDeps,
} from './extensions/full-authority-registration.js';
import { readCollectionSettings, readGlobalSettings } from './services/extension-settings-store.js';
import { clearOperationOptionSecrets } from './services/operation-option-secrets.js';
import type { SandboxConfig } from './extensions/confined/sandbox-limits.js';
import logger from './logger.js';
import type { EventHandler } from './types/index.js';
import {
	gateConfinedExtension,
	VALIDATION_INCOMPLETE,
	type ConfinedEligibleEntry,
	type ConfinedGateVerdict,
	type ConfinedLoadGateDeps,
} from './extensions/confined/load-gate.js';
import { resolveSettingsSubjects, safeExtensionName } from './extensions/settings-subjects.js';
import { resolveConfinedRuntime, type ConfinedSupervisor } from './extensions/confined/supervisor.js';
import { describePosture, type SandboxPosture } from './extensions/confined/sandbox-hardening.js';
import getModuleDefault from './utils/get-module-default.js';
import { filterServerExtensions } from './utils/filter-server-extensions.js';
import { sanitizeExtensionError, type SanitizedExtensionError } from './utils/sanitize-extension-error.js';
import { JobQueue } from './utils/job-queue.js';

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

// Only available owners expose their raw subject and declaration; others expose sanitized diagnostics.
export type SettingsOwner = {
	subject?: string;
	displaySubject: string;
	status: 'available' | 'unavailable';
	reason?: SanitizedExtensionError;
	declaration?: ExtensionSettings;
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

export { findSharedDepAsset } from './extensions/app-bundle.js';

export class ExtensionManager {
	private isLoaded = false;
	private options: Options;

	private extensions: Extension[] = [];
	private serverExtensions: Extension[] = [];

	// Object identity distinguishes same-name packages. Rebuilt each load to bind the exact
	// probed bytes and validated capabilities; bundle-entry capabilities are never merged.
	private confinedEligible = new Map<Extension, ConfinedEligibleEntry>();

	private settingsEligible = new Set<Extension>();

	// isLoaded also becomes true after caught discovery failures; it cannot prove catalogue completeness.
	private settingsDiscoverySucceeded = false;

	// Scan failures invalidate the catalogue; individual package failures only exclude that package.
	private discoveryScanFailed = false;

	// Public reasons omit environment variable names; collision details containing them are log-only.
	private settingsIneligible = new Map<Extension, SanitizedExtensionError>();

	// Includes ineligible and unserved owners, in discovery order.
	private settingsOwners: Extension[] = [];

	// Diagnostics include app extensions even when SERVE_APP excludes them from serving and bundling.
	private discoveredAppExtensions: Extension[] = [];

	// Keep ineligible owners' declarations so admin reads still mask their stored secrets.
	private declaredSettingsBySubject = new Map<string, ExtensionSettings[]>();

	// Test overrides take precedence over the runtime-resolved gate dependencies.
	private confinedGateDeps: ConfinedLoadGateDeps = {};

	// Probes use this load's resolved sandbox posture, not the default supervisor.
	private confinedRuntimeDeps: ConfinedLoadGateDeps = {};

	// Runtime failure skips confined gating without blocking inherited extensions.
	private confinedRuntimeUnavailable = false;

	// Bindings reuse the posture-validated supervisor from this load.
	private confinedRuntime: { supervisor: ConfinedSupervisor; config: SandboxConfig } | undefined;

	private confinedRuntimePosture: SandboxPosture | undefined;

	private appExtensions: AppExtensions = null;
	private appExtensionChunks: Map<string, string>;
	private apiExtensions: ApiExtensions = [];
	private diagnostics: ExtensionDiagnostic[] = [];
	private appBundleFailure: SanitizedExtensionError | null = null;

	private apiEmitter: Emitter;
	private hookEvents: EventHandler[] = [];
	private endpointRouter: Router;

	// Include inherited routes so confined collisions are rejected rather than resolved by Express order.
	private registeredEndpointRoutes = new Set<string>();

	private confinedRegistrar: ConfinedRegistrar;
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

		this.confinedRegistrar = new ConfinedRegistrar({
			runtime: () => this.confinedRuntime,
			eligible: () => this.confinedEligible,
			endpointRouter: () => this.endpointRouter,
			registeredEndpointRoutes: () => this.registeredEndpointRoutes,
			hookEvents: () => this.hookEvents,
			getSettingsOwner: (subject) => this.getSettingsOwner(subject),
			recordLoaded: (extension) => this.recordLoaded(extension),
			recordFailed: (extension, reason) => this.recordFailed(extension, reason),
			recordBundle: (extension, entries) => this.recordBundle(extension, entries),
		});
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
		return diagnosticsLog.copyDiagnostics(this.diagnostics);
	}

	private diagnosticsView(): DiagnosticsView {
		return {
			diagnostics: this.diagnostics,
			capabilitiesOf: (extension) => this.confinedEligible.get(extension)?.capabilities,
			settingsStatusOf: (extension) => {
				if (extension.settings === undefined) return undefined;
				if (this.settingsEligible.has(extension)) return { status: 'available' };

				const reason = this.settingsIneligible.get(extension);
				return reason !== undefined ? { status: 'unavailable', reason } : undefined;
			},
		};
	}

	public isSettingsEligible(extension: Extension): boolean {
		return this.settingsEligible.has(extension);
	}

	public getSettingsOwner(subject: string): Extension | undefined {
		for (const extension of this.settingsEligible) {
			if (extension.name === subject) return extension;
		}

		return undefined;
	}

	/**
	 * Includes duplicate and ineligible owners for secret masking, not authorization.
	 * Writes and confined reads must use the eligibility-gated owner.
	 */
	public getDeclaredSettings(subject: string): ExtensionSettings[] {
		return this.declaredSettingsBySubject.get(subject) ?? [];
	}

	public isSettingsDiscoveryComplete(): boolean {
		return this.settingsDiscoverySucceeded;
	}

	public getSettingsOwners(): SettingsOwner[] {
		return this.settingsOwners.map((extension) => {
			const displaySubject = safeExtensionName(extension.name);

			if (this.settingsEligible.has(extension)) {
				return {
					subject: extension.name,
					displaySubject,
					status: 'available' as const,
					declaration: structuredClone(extension.settings!),
				};
			}

			const reason = this.settingsIneligible.get(extension);

			return {
				displaySubject,
				status: 'unavailable' as const,
				...(reason && { reason: { ...reason } }),
			};
		});
	}

	/**
	 * Inspect load state without resolving the runtime: diagnostics must not validate
	 * sandbox configuration when no confined extension needs it.
	 */
	public getConfinedRuntimeMeta(): ConfinedRuntimeMeta {
		const posture = this.confinedRuntime !== undefined ? this.confinedRuntimePosture : undefined;
		return diagnosticsLog.summarizeConfinedRuntime(posture, this.confinedRuntimeUnavailable);
	}

	private logExtensionStatus(): void {
		diagnosticsLog.logExtensionStatus(this.diagnostics);
	}

	private recordLoaded(extension: Extension): void {
		diagnosticsLog.recordLoaded(this.diagnosticsView(), extension);
	}

	private recordFailed(extension: Extension, reason: SanitizedExtensionError): void {
		diagnosticsLog.recordFailed(this.diagnosticsView(), extension, reason);
	}

	/**
	 * Resolve only for confined extensions so invalid sandbox configuration cannot
	 * block inherited extensions. Gating and execution share the resolved supervisor.
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
	 * Failed gates never downgrade an extension to full authority. Successful gates
	 * defer public diagnostics until registration. Probes run sequentially so sibling
	 * probes cannot exhaust the supervisor's capacity.
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
				// Isolate a failed gate without aborting other extensions' loads.
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
				// Dropping per-entry reference declarations would expose configured values to the guest.
				if (verdict.entryOptionDelivery !== undefined) entry.entryOptionDelivery = verdict.entryOptionDelivery;
				if (verdict.events !== undefined) entry.events = verdict.events;

				this.confinedEligible.set(extension, entry);
			} else {
				this.recordFailed(extension, verdict.error);
			}
		}
	}

	/**
	 * Subject failures disable settings access, not the extension's load.
	 */
	private gateSettingsSubjects(discovered: Extension[]): void {
		const statuses = resolveSettingsSubjects(discovered);

		this.settingsEligible = new Set();
		this.settingsIneligible = new Map();
		this.settingsOwners = discovered.filter((extension) => extension.settings !== undefined);
		this.declaredSettingsBySubject = new Map();

		for (const extension of this.settingsOwners) {
			const declarations = this.declaredSettingsBySubject.get(extension.name) ?? [];
			declarations.push(extension.settings!);
			this.declaredSettingsBySubject.set(extension.name, declarations);
		}

		for (const [extension, status] of statuses) {
			if (status.eligible) {
				this.settingsEligible.add(extension);
			} else {
				this.settingsIneligible.set(extension, status.reason);
				logger.warn(`Settings disabled: ${status.logDetail ?? status.reason.detail}`);
			}
		}
	}

	private registerConfinedOperations(): void {
		this.confinedRegistrar.registerOperations();
	}

	private registerConfinedEndpoints(): void {
		this.confinedRegistrar.registerEndpoints();
	}

	private registerConfinedHooks(): void {
		this.confinedRegistrar.registerHooks();
	}

	private registerConfinedBundles(): void {
		this.confinedRegistrar.registerBundles();
	}

	private recordBundle(extension: BundleExtension, entries: ExtensionDiagnosticEntry[]): void {
		diagnosticsLog.recordBundle(this.diagnosticsView(), extension, entries);
	}

	private recordAppDiagnostics(): void {
		diagnosticsLog.recordAppDiagnostics(this.diagnosticsView(), this.discoveredAppExtensions, this.appBundleFailure);
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
		this.settingsEligible.clear();
		this.settingsIneligible.clear();
		this.settingsDiscoverySucceeded = false;
		this.settingsOwners = [];
		this.discoveredAppExtensions = [];
		this.declaredSettingsBySubject.clear();
		this.confinedRuntimeDeps = {};
		this.confinedRuntimeUnavailable = false;
		this.confinedRuntime = undefined;
		this.confinedRuntimePosture = undefined;
		this.hookEmbedsHead = [];
		this.hookEmbedsBody = [];

		let discovered: Extension[] = [];
		let discoverySucceeded = false;

		try {
			await ensureExtensionDirs(env['EXTENSIONS_PATH'], NESTED_EXTENSION_TYPES);

			discovered = await this.getExtensions();

			// Settings ownership uses the unfiltered discoveries even when SERVE_APP disables app serving.
			this.extensions = env['SERVE_APP']
				? discovered
				: discovered.filter((extension) => APP_EXTENSION_TYPES.includes(extension.type as any) === false);

			this.discoveredAppExtensions = discovered.filter((extension) => isIn(extension.type, APP_EXTENSION_TYPES));
			discoverySucceeded = true;
		} catch (err: any) {
			const reason = sanitizeExtensionError(err, 'DISCOVERY_FAILED');
			logger.warn(`Couldn't load extensions: ${reason.code} ${reason.detail}`);
			this.diagnostics.push({ name: '(extension discovery)', type: null, local: true, status: 'failed', reason });
		}

		this.serverExtensions = filterServerExtensions(this.extensions);

		await this.prepareConfinedRuntime();
		await this.gateConfinedExtensions();
		this.gateSettingsSubjects(discovered);
		this.settingsDiscoverySucceeded = discoverySucceeded && !this.discoveryScanFailed;

		await this.registerHooks();
		await this.registerEndpoints();
		await this.registerOperations();
		await this.registerBundles();
		// Inherited operations, including bundle entries, must exist before collision checks.
		this.registerConfinedOperations();
		// Route collision checks must also see inherited bundle endpoints.
		this.registerConfinedEndpoints();
		this.registerConfinedHooks();
		// Bundle collision checks run after inherited and top-level confined registrations.
		this.registerConfinedBundles();

		if (env['SERVE_APP']) {
			this.appExtensions = await this.generateExtensionBundle();
		}

		this.recordAppDiagnostics();

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		await this.unregisterApiExtensions();

		this.serverExtensions = [];
		this.confinedEligible.clear();
		this.settingsEligible.clear();
		this.settingsIneligible.clear();
		this.settingsDiscoverySucceeded = false;
		this.settingsOwners = [];
		this.discoveredAppExtensions = [];
		this.declaredSettingsBySubject.clear();
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

			// Package entrypoints lie outside the nested-layout globs and need individual watches.
			// Keep nested paths glob-owned: chokidar unwatch suppresses even matching globs after re-add.
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
		this.discoveryScanFailed = false;

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
			this.discoveryScanFailed = true;

			const reason = sanitizeExtensionError(error, 'DISCOVERY_FAILED');

			this.diagnostics.push({
				name: '(local extensions)',
				type: null,
				local: true,
				status: 'failed',
				reason,
			});
		}

		return [...packageExtensions, ...localPackageExtensions, ...localExtensions];
	}

	private async generateExtensionBundle(): Promise<string | null> {
		this.appExtensionChunks.clear();

		const bundle = await buildAppExtensionBundle(this.extensions);

		for (const [name, code] of bundle.chunks) {
			this.appExtensionChunks.set(name, code);
		}

		if (bundle.failure !== null) {
			this.appBundleFailure = bundle.failure;
			logger.warn(`Couldn't bundle app extensions: ${bundle.failure.code} ${bundle.failure.detail}`);
		}

		return bundle.code;
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

				this.registerHook(config, hook.name, hook.name);

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

				this.registerEndpoint(config, endpoint.name, endpoint.name);

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

				this.registerOperation(config, operation.name);

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

				// Hook entry names seed schedule identities and must be unique within a bundle.
				const hookNames = new Set<string>();

				for (const { name } of configs.hooks) {
					if (hookNames.has(name)) {
						throw new Error(`bundle declares more than one hook entry named "${name}"`);
					}

					hookNames.add(name);
				}

				for (const { config, name } of configs.hooks) {
					this.registerHook(config, bundle.name, `${bundle.name}:${name}`);
				}

				for (const { config, name } of configs.endpoints) {
					this.registerEndpoint(config, name, bundle.name);
				}

				for (const { config } of configs.operations) {
					this.registerOperation(config, bundle.name);
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

	private settingsReaderFor(subject: string) {
		return buildExtensionSettingsReader({
			subject,
			getDeclaration: () => this.getSettingsOwner(subject)?.settings,
			readGlobalRows: () => readGlobalSettings(getDatabase(), subject),
			readCollectionRows: (collection) => readCollectionSettings(getDatabase(), subject, collection),
		});
	}

	// The manager owns the registration state; the leaf functions receive it and mutate it here.
	private fullAuthorityDeps(): FullAuthorityRegistrationDeps {
		return {
			apiEmitter: this.apiEmitter,
			makeSettingsReader: (subject) => this.settingsReaderFor(subject),
			hookEvents: this.hookEvents,
			hookEmbedsHead: this.hookEmbedsHead,
			hookEmbedsBody: this.hookEmbedsBody,
			scheduleEnabled: () => this.options.schedule,
			endpointRouter: this.endpointRouter,
			registeredEndpointRoutes: this.registeredEndpointRoutes,
		};
	}

	private registerHook(register: HookConfig, subject: string, scheduleKey: string): void {
		registerFullAuthorityHook(register, subject, scheduleKey, this.fullAuthorityDeps());
	}

	private registerEndpoint(config: EndpointConfig, name: string, subject: string): void {
		registerFullAuthorityEndpoint(config, name, subject, this.fullAuthorityDeps());
	}

	private registerOperation(config: OperationApiConfig, subject?: string): void {
		registerFullAuthorityOperation(config, subject, this.fullAuthorityDeps());
	}

	private async unregisterApiExtensions(): Promise<void> {
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
					await event.job.stop();
					break;
			}
		}

		this.hookEvents = [];

		this.endpointRouter.stack = [];
		this.registeredEndpointRoutes.clear();

		const flowManager = getFlowManager();

		flowManager.clearOperations();
		flowManager.clearConfinedOperations();
		clearOperationOptionSecrets();

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
