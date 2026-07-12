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

// One settings-declaring owner for the management surface. `subject` is the validated raw
// package name, present only for an available owner, and `declaration` likewise, so an
// ineligible owner exposes nothing beyond its sanitized name and reason.
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

// The per-contribution facts a confined runner binding needs, identical for a
// top-level extension and one server entry of a bundle. A bundle entry adds the
// `type:name` key so the engine selects it from the shared CairnBundle artifact.

export { findSharedDepAsset } from './extensions/app-bundle.js';

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

	private settingsEligible = new Set<Extension>();

	// The public, variable-free reason per ineligible owner, what the diagnostics field
	// and the owners endpoint publish. The variable-bearing collision detail is log-only.
	private settingsIneligible = new Map<Extension, SanitizedExtensionError>();

	// Every discovered settings-declaring owner in discovery order, whatever its
	// eligibility and whether or not this instance serves it.
	private settingsOwners: Extension[] = [];

	// Every discovered app extension, for the diagnostics listing. Serving and bundling
	// stay on the SERVE_APP-filtered set; the listing is topology-complete.
	private discoveredAppExtensions: Extension[] = [];

	// Every discovered owner's declaration by subject, eligibility-independent, so the
	// admin read's secret masking cannot weaken when an owner is gated ineligible.
	private declaredSettingsBySubject = new Map<string, ExtensionSettings[]>();

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
	 * Every discovered declaration for a subject, whatever its eligibility, duplicates
	 * included. Concealment consumers mask from this set so a stored secret under a
	 * gated-ineligible owner never reads back in cleartext. Function-granting paths
	 * (writes, confined reads) stay on the eligibility-gated owner.
	 */
	public getDeclaredSettings(subject: string): ExtensionSettings[] {
		return this.declaredSettingsBySubject.get(subject) ?? [];
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
	 * The global confined-runtime metadata for the diagnostics response. Derived from the
	 * load state, never by resolving the runtime, so a plain-only load (no confined
	 * extension) stays `not-required` and never touches the sandbox env.
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
	 * Gates each settings owner's durable subject after confined gating, so any confined
	 * capabilities it reads are already validated. A bad or colliding subject is refused
	 * settings only, never failing the extension's load.
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

		try {
			await ensureExtensionDirs(env['EXTENSIONS_PATH'], NESTED_EXTENSION_TYPES);

			discovered = await this.getExtensions();

			// The settings gate sees every discovered extension so an app extension's settings
			// ownership resolves even when SERVE_APP is off and an external bundler serves the app.
			// this.extensions stays the SERVE_APP-filtered set used for serving and listing.
			this.extensions = env['SERVE_APP']
				? discovered
				: discovered.filter((extension) => APP_EXTENSION_TYPES.includes(extension.type as any) === false);

			this.discoveredAppExtensions = discovered.filter((extension) => isIn(extension.type, APP_EXTENSION_TYPES));
		} catch (err: any) {
			const reason = sanitizeExtensionError(err, 'DISCOVERY_FAILED');
			logger.warn(`Couldn't load extensions: ${reason.code} ${reason.detail}`);
			this.diagnostics.push({ name: '(extension discovery)', type: null, local: true, status: 'failed', reason });
		}

		this.serverExtensions = filterServerExtensions(this.extensions);

		await this.prepareConfinedRuntime();
		await this.gateConfinedExtensions();
		this.gateSettingsSubjects(discovered);

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
		}

		this.recordAppDiagnostics();

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		this.unregisterApiExtensions();

		this.serverExtensions = [];
		this.confinedEligible.clear();
		this.settingsEligible.clear();
		this.settingsIneligible.clear();
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

				this.registerHook(config, hook.name);

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

				for (const { config } of configs.hooks) {
					this.registerHook(config, bundle.name);
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

	private registerHook(register: HookConfig, subject: string): void {
		registerFullAuthorityHook(register, subject, this.fullAuthorityDeps());
	}

	private registerEndpoint(config: EndpointConfig, name: string, subject: string): void {
		registerFullAuthorityEndpoint(config, name, subject, this.fullAuthorityDeps());
	}

	private registerOperation(config: OperationApiConfig, subject?: string): void {
		registerFullAuthorityOperation(config, subject, this.fullAuthorityDeps());
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
