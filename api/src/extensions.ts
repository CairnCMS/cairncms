import {
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
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
import { getFlowManager } from './flows.js';
import logger from './logger.js';
import * as services from './services/index.js';
import type { EventHandler } from './types/index.js';
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

export class ExtensionManager {
	private isLoaded = false;
	private options: Options;

	private extensions: Extension[] = [];
	private serverExtensions: Extension[] = [];

	private appExtensions: AppExtensions = null;
	private appExtensionChunks: Map<string, string>;
	private apiExtensions: ApiExtensions = [];
	private diagnostics: ExtensionDiagnostic[] = [];
	private appBundleFailure: SanitizedExtensionError | null = null;

	private apiEmitter: Emitter;
	private hookEvents: EventHandler[] = [];
	private endpointRouter: Router;
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

		await this.registerHooks();
		await this.registerEndpoints();
		await this.registerOperations();
		await this.registerBundles();

		if (env['SERVE_APP']) {
			this.appExtensions = await this.generateExtensionBundle();
			this.recordAppDiagnostics();
		}

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		this.unregisterApiExtensions();

		this.serverExtensions = [];

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
			const toPackageExtensionPaths = (extensions: Extension[]) =>
				extensions
					.filter((extension) => !extension.local || extension.type === 'bundle')
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

		const flowManager = getFlowManager();

		flowManager.clearOperations();

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
