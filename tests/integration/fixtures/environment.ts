/* eslint-disable no-console, no-empty-pattern */
import { test, inject } from 'vitest';
import type { Fixtures } from '@vitest/runner';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, cp, writeFile, appendFile, readFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { setupRequest as request } from './request';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';
import { openOrigin } from '../harness/origin.mjs';
import { ownCli } from '../harness/owned-cli.mjs';
import { waitChild } from '../harness/wait-child.mjs';
import { dropDatabase } from './drop-database.mjs';
import { initializeDatabase } from '../harness/pristine.mjs';
import { removeMarkedDirectory } from '../harness/owned-directory.mjs';

type Runtime = {
	vendor: string;
	directory: string;
	connection?: { host: string; port: number; user: string; password: string };
	pristine?: { directory: string; buildHash: string };
};
declare module 'vitest' {
	export interface ProvidedContext {
		integration: Runtime;
	}
}
export type CliOptions = {
	env?: Record<string, string>;
	stdin?: string;
	timeoutMs?: number;
	unreachableDatabase?: boolean;
	emptyExtensions?: boolean;
};
export type Api = {
	directory: string;
	url: string;
	backendUrl: string;
	publicUrl: string;
	adminToken: string;
	database: Knex;
	child: ChildProcess;
	maxBatchMutation: number;
	readLogs: () => Promise<string>;
	start: (
		overrides?: Record<string, string>,
		options?: { absoluteOrigin?: boolean; onSpawn?: (child: ChildProcess) => void }
	) => Promise<{ url: string; child: ChildProcess; publicUrl: string }>;
	stop: (child: ChildProcess) => Promise<void>;
	startNode: (entry: string, args: string[], options?: { timeoutMs?: number }) => ReturnType<typeof ownCli>;
	startCli: (args: string[], options?: Omit<CliOptions, 'stdin'>) => ReturnType<typeof ownCli>;
	cli: (
		args: string[],
		options?: CliOptions
	) => Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }>;
	available: () => boolean;
	recordTiming: (name: string, started: number) => void;
};

export type EnvironmentOptions = {
	bootstrap?: 'fresh';
	migrations?: string[];
	hooks?: boolean;
	hookFixtures?: string[];
	absoluteOrigin?: boolean;
	origin?: Awaited<ReturnType<typeof openOrigin>>;
	env?: Record<string, string>;
	extensions?: string[];
	extensionStatuses?: Record<string, string>;
	extensionNames?: Record<string, string>;
};

const project = fileURLToPath(new URL('../../../', import.meta.url));

async function stop(child: ChildProcess) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	child.kill('SIGTERM');
	const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);

	try {
		await exit;
	} finally {
		clearTimeout(timer);
	}
}

export async function withEnvironment(
	runtime: Runtime,
	hooks: boolean,
	use: (api: Api) => Promise<void>,
	signal?: AbortSignal,
	options: EnvironmentOptions = {}
) {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-integration-'));
	const id = `test_${randomUUID().replaceAll('-', '')}`;
	const logPath = join(runtime.directory, `${id}.log`);
	const log = createWriteStream(logPath);
	const children: ChildProcess[] = [];
	const expectedStops = new Set<ChildProcess>();
	let ownershipWrite = Promise.resolve();
	let database: Knex | undefined;
	let admin: Knex | undefined;
	let created = false;
	let initialized = false;
	let createDatabase: (() => Promise<void>) | undefined;
	let failed: unknown;
	let closing = false;
	let unexpectedExit: Error | undefined;
	let origin: Awaited<ReturnType<typeof openOrigin>> | undefined;
	const companionOrigins: Awaited<ReturnType<typeof openOrigin>>[] = [];
	const timings: Record<string, number> = {};
	let phase = 'database';
	let phaseStart = performance.now();
	console.log(`[${runtime.vendor}] ${id} database starting (connection/query deadline: 10s)`);

	const mark = (next: string) => {
		timings[phase] = performance.now() - phaseStart;
		console.log(`[${runtime.vendor}] ${id} ${phase}: ${timings[phase]}ms`);
		phase = next;
		phaseStart = performance.now();
		if (next !== 'done')
			console.log(
				`[${runtime.vendor}] ${id} ${next} starting${
					['bootstrap', 'startup'].includes(next) ? ' (phase deadline: 90s; test deadline also applies)' : ''
				}`
			);
	};

	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		// Legitimate parent inputs for production's systemd hardening probe.
		// The sandbox child still uses the production environment allowlist.
		DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
		XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
		NODE_ENV: 'production',
		NODE_OPTIONS: '',
		TZ: 'UTC',
		KEY: randomUUID(),
		SECRET: randomUUID(),
		HOST: '127.0.0.1',
		PORT: '0',
		PUBLIC_URL: '/',
		SERVE_APP: 'false',
		CACHE_SCHEMA: 'true',
		CACHE_ENABLED: 'false',
		RATE_LIMITER_ENABLED: 'false',
		ACCESS_TOKEN_TTL: '25d',
		MAX_BATCH_MUTATION: '100',
		MAX_PAYLOAD_SIZE: '10mb',
		MAX_RELATIONAL_DEPTH: '5',
		DB_EXCLUDE_TABLES: 'knex_migrations,knex_migrations_lock,spatial_ref_sys,sysdiagrams',
		ASSETS_TRANSFORM_MAX_CONCURRENT: '2',
		DB_HEALTHCHECK_THRESHOLD: '1000',
		// Public fixture key; never use outside these isolated test environments.
		SECRETS_ENCRYPTION_KEY: 'YmxhY2tib3gtc2VjcmV0cy1lbmNyeXB0aW9uLWtleSE=',
		ADMIN_EMAIL: 'bootstrap@example.com',
		ADMIN_PASSWORD: 'BootstrapPassword123',
		STORAGE_LOCATIONS: 'local',
		STORAGE_LOCAL_DRIVER: 'local',
		STORAGE_LOCAL_ROOT: join(directory, 'uploads'),
		EXTENSIONS_PATH: join(directory, 'extensions'),
		EXTENSIONS_AUTO_RELOAD: 'false',
		LOG_LEVEL: 'info',
		TELEMETRY: 'false',
	};

	const launch = (entry: string, childEnv = env, args: string[] = []) => {
		signal?.throwIfAborted();

		const child = spawn(
			process.execPath,
			[
				'--no-node-snapshot',
				...(isAbsolute(entry) ? ['--import', join(project, 'tests/integration/harness/tool-lifetime.mjs')] : []),
				isAbsolute(entry) ? entry : join(project, 'tests/integration/harness', entry),
				...args,
			],
			{
				cwd: directory,
				env: childEnv,
				stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			}
		);

		children.push(child);

		const ownership =
			JSON.stringify({ directory, database: id, owner: process.pid, children: children.map((c) => c.pid) }) + '\n';

		ownershipWrite = ownershipWrite.then(() => writeFile(join(runtime.directory, `${id}.owner.json`), ownership));

		void ownershipWrite.catch((error) => {
			console.error('Could not record owned processes', error);
		});

		child.stdout!.pipe(log, { end: false });
		child.stderr!.pipe(log, { end: false });
		child.on('error', (error) => console.error(`[${runtime.vendor}] ${entry} spawn error`, error));

		child.on('exit', (code, exitSignal) => {
			if (!closing && !signal?.aborted && !expectedStops.has(child) && (entry === 'api-entry.mjs' || code !== 0)) {
				unexpectedExit = new Error(`${entry} exited ${code ?? exitSignal}; diagnostics: ${logPath}`);
				console.error(`[${runtime.vendor}] ${unexpectedExit.message}`);
			}
		});

		return child;
	};

	const wait = <T>(child: ChildProcess, ready: boolean): Promise<T> =>
		waitChild(child, { ready, phase, diagnostics: logPath }) as Promise<T>;

	const cancel = () => {
		for (const child of children) void stop(child);
	};

	const configured = (overrides: Record<string, string> = {}) => {
		const result = { ...env };

		for (const [key, value] of Object.entries(overrides)) {
			if (/^(DB_|PORT$|HOST$|PUBLIC_URL$|EXTENSIONS_PATH$|STORAGE_LOCAL_ROOT$|PATH$)/.test(key))
				throw new Error(`Environment fixture owns ${key}; use its resource options`);
			result[key] = value;
		}

		return result;
	};

	signal?.addEventListener('abort', cancel, { once: true });

	try {
		signal?.throwIfAborted();

		await writeFile(join(directory, '.integration-owner.json'), JSON.stringify({ id, reports: runtime.directory }));

		await writeFile(
			join(runtime.directory, `${id}.owner.json`),
			JSON.stringify({ directory, database: id, owner: process.pid }) + '\n'
		);

		Object.assign(env, configured(options.env));

		if (options.origin || options.absoluteOrigin) {
			origin = options.origin ?? (await openOrigin());
			env.PUBLIC_URL = origin.url;
		}

		await mkdir(env.STORAGE_LOCAL_ROOT!, { recursive: true });
		await mkdir(env.EXTENSIONS_PATH!, { recursive: true });
		await mkdir(join(directory, 'cli-empty-extensions'), { recursive: true });

		for (const extension of options.extensions ?? []) {
			await cp(join(project, 'tests/blackbox/extensions', extension), join(env.EXTENSIONS_PATH!, extension), {
				recursive: true,
			});
		}

		for (const migration of options.migrations ?? []) {
			await mkdir(join(env.EXTENSIONS_PATH!, 'migrations'), { recursive: true });

			await copyFile(
				join(project, 'tests/integration/fixtures/migrations', migration),
				join(env.EXTENSIONS_PATH!, 'migrations', migration)
			);
		}

		await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: {} }) + '\n');

		if (runtime.vendor === 'sqlite3') {
			env.DB_CLIENT = 'sqlite3';
			env.DB_FILENAME = join(directory, 'database.sqlite');

			database = knex({
				client: 'sqlite3',
				connection: { filename: env.DB_FILENAME },
				useNullAsDefault: true,
				pool: {
					min: 0,
					max: 1,
					afterCreate: (connection: any, done: (error: Error | null, connection: any) => void) => {
						connection.run('PRAGMA foreign_keys = ON', (error: Error | null) => done(error, connection));
					},
				},
			});
		} else {
			const postgres = runtime.vendor.startsWith('postgres');
			const client = postgres ? 'pg' : 'mysql2';

			const connectionOptions = postgres
				? { connectionTimeoutMillis: 10_000, statement_timeout: 10_000 }
				: { connectTimeout: 10_000 };

			admin = knex({
				client,
				connection: {
					...runtime.connection,
					database: postgres ? 'postgres' : 'mysql',
					...connectionOptions,
				},
				pool: { min: 0, max: 1 },
				acquireConnectionTimeout: 10_000,
			});

			const create = async () => {
				// The image's template contains the same PostGIS extensions as its initial database.
				await admin!
					.raw(
						postgres
							? 'CREATE DATABASE ?? TEMPLATE template_postgis'
							: 'CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
						[id]
					)
					.timeout(10_000);
			};

			// Record the target before provisioning; cancellation can interrupt database creation.
			created = true;
			if (postgres) createDatabase = create;
			else await create();

			env.DB_CLIENT = postgres ? 'pg' : 'mysql';
			env.DB_HOST = runtime.connection!.host;
			env.DB_PORT = String(runtime.connection!.port);
			env.DB_USER = runtime.connection!.user;
			env.DB_PASSWORD = runtime.connection!.password;
			env.DB_DATABASE = id;

			database = knex({
				client,
				connection: { ...runtime.connection, database: id, ...connectionOptions },
				pool: { min: 0, max: 1 },
				acquireConnectionTimeout: 10_000,
			});
		}

		mark('bootstrap');

		await initializeDatabase({
			runtime,
			id,
			env,
			database,
			signal,
			options,
			createDatabase,
			bootstrap: async (cancellation: AbortSignal) => {
				cancellation.throwIfAborted();
				const child = launch('bootstrap-entry.mjs');

				const abort = () => {
					void stop(child);
				};

				cancellation.addEventListener('abort', abort, { once: true });

				try {
					await wait(child, false);
				} finally {
					cancellation.removeEventListener('abort', abort);
				}
			},
		});

		initialized = true;

		const hookFixtures = [...(hooks ? ['action-verify-create'] : []), ...(options.hookFixtures ?? [])];

		if (hookFixtures.length) {
			await database.schema.createTable('tests_extensions_log', (table) => {
				table.increments('id').primary();
				table.string('key');
				table.string('value');
			});

			for (const name of hookFixtures) {
				const extension = join(env.EXTENSIONS_PATH!, 'hooks', name);
				await mkdir(extension, { recursive: true });
				await copyFile(join(project, 'tests/blackbox/extensions/hooks', name, 'index.js'), join(extension, 'index.js'));
			}
		}

		mark('startup');
		const child = launch('api-entry.mjs');
		const startup = await wait<{ url: string; publicUrl: string }>(child, true);
		const backendUrl = startup.url;
		if (startup.publicUrl !== env.PUBLIC_URL) throw new Error('Application PUBLIC_URL differs from the fixture origin');
		origin?.connect(backendUrl);
		const url = origin?.url ?? backendUrl;
		await request(url).get('/server/ping').expect(200);
		mark('fixtures-and-tests');

		const login = await request(url)
			.post('/auth/login')
			.send({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })
			.expect(200);

		const adminToken = login.body.data.access_token;
		if (typeof adminToken !== 'string') throw new Error('Bootstrap login did not return an access token');

		if (options.extensions?.length) {
			const inventory = await request(url).get('/extensions').auth(adminToken, { type: 'bearer' }).expect(200);

			const extensions = Object.fromEntries(
				inventory.body.data.map((entry: { name: string; status: string }) => [entry.name, entry])
			);

			for (const extension of options.extensions) {
				const name = options.extensionNames?.[extension] ?? basename(extension);
				const expected = options.extensionStatuses?.[name] ?? 'loaded';
				if (extensions[name]?.status !== expected)
					throw new Error(`Required extension ${name}: expected ${expected}, got ${JSON.stringify(extensions[name])}`);
			}

			await writeFile(join(runtime.directory, `${id}.extensions.json`), JSON.stringify(inventory.body, null, 2) + '\n');
		}

		const extensionHashes: Record<string, string> = {};

		const hashExtensions = async (path: string, relative = '') => {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const name = join(relative, entry.name);
				if (entry.isDirectory()) await hashExtensions(join(path, entry.name), name);
				else if (entry.isFile())
					extensionHashes[name] = createHash('sha256')
						.update(await readFile(join(path, entry.name)))
						.digest('hex');
			}
		};

		await hashExtensions(env.EXTENSIONS_PATH!);

		await writeFile(
			join(runtime.directory, `${id}.runtime.json`),
			JSON.stringify(
				{
					...startup,
					node: process.version,
					hardeningHostInputs: {
						sessionBusAddressPresent: Boolean(env.DBUS_SESSION_BUS_ADDRESS),
						runtimeDirectoryPresent: Boolean(env.XDG_RUNTIME_DIR),
					},
					environmentSha256: createHash('sha256').update(JSON.stringify(env)).digest('hex'),
					configuration: Object.fromEntries(
						[
							'NODE_ENV',
							'TZ',
							'HOST',
							'PORT',
							'PUBLIC_URL',
							'SERVE_APP',
							'CACHE_SCHEMA',
							'CACHE_ENABLED',
							'RATE_LIMITER_ENABLED',
							'MAX_BATCH_MUTATION',
							'MAX_PAYLOAD_SIZE',
							'MAX_RELATIONAL_DEPTH',
							'DB_CLIENT',
							'DB_HOST',
							'DB_PORT',
							'DB_DATABASE',
							'LOG_LEVEL',
							'LOG_STYLE',
							'STORAGE_LOCATIONS',
							'EXTENSIONS_SANDBOX_OS_HARDENING',
						]
							.filter((key) => env[key] !== undefined)
							.map((key) => [key, env[key]])
					),
					extensionHashes,
				},
				null,
				2
			) + '\n'
		);

		const startCli: Api['startCli'] = (args, options = {}) => {
			const childEnv = configured(options.env);
			if (options.emptyExtensions) childEnv.EXTENSIONS_PATH = join(directory, 'cli-empty-extensions');

			if (options.unreachableDatabase) {
				// This fault stays inside an owned environment.
				// Arbitrary database overrides remain forbidden through the env option.
				if (runtime.vendor === 'sqlite3') childEnv.DB_FILENAME = join(directory, 'unreachable', 'database.sqlite');
				else {
					childEnv.DB_HOST = '127.0.0.1';
					childEnv.DB_PORT = '1';
				}
			}

			const child = launch('cli-entry.mjs', childEnv, args);
			// Nonzero CLI status is an asserted product outcome, not an API crash.
			expectedStops.add(child);
			return ownCli(child, { stop, timeoutMs: options.timeoutMs, diagnostics: logPath });
		};

		await use({
			directory,
			url,
			backendUrl,
			publicUrl: startup.publicUrl,
			adminToken,
			database,
			child,
			maxBatchMutation: Number(env.MAX_BATCH_MUTATION),
			readLogs: () => readFile(logPath, 'utf8'),
			start: async (overrides, options) => {
				const childEnv = configured(overrides);
				const companionOrigin = options?.absoluteOrigin ? await openOrigin() : undefined;

				if (companionOrigin) {
					companionOrigins.push(companionOrigin);
					childEnv.PUBLIC_URL = companionOrigin.url;
				}

				const extra = launch('api-entry.mjs', childEnv);
				options?.onSpawn?.(extra);
				const ready = await wait<{ url: string; publicUrl: string }>(extra, true);
				if (ready.publicUrl !== childEnv.PUBLIC_URL)
					throw new Error('Companion PUBLIC_URL differs from its owned origin');
				companionOrigin?.connect(ready.url);
				const url = companionOrigin?.url ?? ready.url;
				await request(url).get('/server/ping').expect(200);
				return { ...ready, url, child: extra };
			},
			stop: async (owned) => {
				if (!children.includes(owned)) throw new Error('Cannot stop a process owned by another environment');
				expectedStops.add(owned);
				await stop(owned);
			},
			startNode: (entry, args, options = {}) => {
				if (!isAbsolute(entry)) throw new Error('Node tool entry must be an absolute resolved path');
				const tool = launch(entry, env, args);
				expectedStops.add(tool);
				return ownCli(tool, { stop, timeoutMs: options.timeoutMs, diagnostics: logPath });
			},
			startCli,
			cli: async (args, options = {}) => {
				const cli = startCli(args, options);
				cli.child.stdin!.end(options.stdin ?? '');
				return cli.result;
			},
			available: () => !unexpectedExit && child.exitCode === null && child.signalCode === null,
			recordTiming: (name, started) => {
				timings[name] = (timings[name] ?? 0) + performance.now() - started;
			},
		});
	} catch (error) {
		failed = error;
		console.error(`[${runtime.vendor}] ${phase} failed; diagnostics: ${logPath}`);
		console.error((await readFile(logPath, 'utf8').catch(() => '')).slice(-8000));
		throw error;
	} finally {
		closing = true;
		failed ??= unexpectedExit;
		mark('cleanup');
		const errors: unknown[] = [];

		try {
			await ownershipWrite;
		} catch (error) {
			errors.push(error);
		}

		for (const ownedOrigin of [origin, ...companionOrigins]) {
			try {
				await ownedOrigin?.close();
			} catch (error) {
				errors.push(error);
			}
		}

		for (const child of children.reverse()) {
			try {
				await stop(child);
			} catch (error) {
				errors.push(error);
			}
		}

		try {
			await database?.destroy();
		} catch (error) {
			errors.push(error);
		}

		try {
			if (created) await dropDatabase(admin!, id, runtime.vendor, { ifExists: !initialized });
		} catch (error) {
			errors.push(error);
		}

		try {
			await admin?.destroy();
		} catch (error) {
			errors.push(error);
		}

		try {
			await removeMarkedDirectory(directory);
		} catch (error) {
			errors.push(error);
		}

		mark('done');
		log.end();
		signal?.removeEventListener('abort', cancel);

		await appendFile(
			join(runtime.directory, 'timings.jsonl'),
			JSON.stringify({ id, ...timings, cleanupErrors: errors.map(String) }) + '\n'
		);

		if (errors.length) {
			console.error('Environment cleanup failed', errors);
			if (!failed) failed = new AggregateError(errors, 'Environment cleanup failed');
		}
	}

	if (failed) throw failed;
}

export function createEnvironmentTest() {
	const controller = new AbortController();
	return test.extend<{
		cancellation: void;
		cancellationSignal: AbortSignal;
		vendor: string;
		teardownFailures: unknown[];
	}>({
		teardownFailures: [
			async ({}, use) => {
				const errors: unknown[] = [];
				await use(errors);
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, 'Owned fixture teardown failed');
			},
			{ scope: 'file', auto: true },
		],
		cancellationSignal: [
			async ({}, use) => {
				await use(controller.signal);
			},
			{ scope: 'file' },
		],
		cancellation: [
			async ({ signal }, use) => {
				const cancel = () => controller.abort(signal.reason);
				signal.addEventListener('abort', cancel, { once: true });

				try {
					await use();
				} finally {
					signal.removeEventListener('abort', cancel);
				}
			},
			{ auto: true },
		],
		vendor: [
			async ({}, use) => {
				await use(inject('integration').vendor);
			},
			{ scope: 'file' },
		],
	});
}

type ApiFixtures = { available: void; apiState: Prerequisite<Api>; api: Api };
type ApiDependencies = {
	configurationState: Prerequisite<EnvironmentOptions>;
	cancellationSignal: AbortSignal;
	teardownFailures: unknown[];
};

// Define service/configuration fixtures first, then extend with these consumers.
// Vitest 3 resolves dependencies when extend() runs; later overrides don't rebind them.
export const apiFixtures: Fixtures<ApiFixtures, ApiDependencies> = {
	available: [
		async ({ api, cancellationSignal, task, skip }, use) => {
			if (cancellationSignal.aborted || !api.available()) {
				task.meta.integrationBlockedBy = 'Owned API stopped';
				skip('Owned API stopped; see the owning file failure');
			}

			await use();
		},
		{ auto: true },
	],
	apiState: [
		async ({ configurationState, cancellationSignal, teardownFailures }, use) => {
			if (!configurationState.ok) return use(configurationState);
			const options = configurationState.value;

			await capturePrerequisite<Api>(
				(ready) => withEnvironment(inject('integration'), options.hooks ?? false, ready, cancellationSignal, options),
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	api: async ({ apiState, task, skip }, use) => {
		await use(requirePrerequisite(apiState, 'API environment', { task, skip }));
	},
};

export function createApiTest(options: boolean | EnvironmentOptions = false) {
	const configuration = typeof options === 'boolean' ? { hooks: options } : options;
	return createEnvironmentTest()
		.extend<{ configurationState: Prerequisite<EnvironmentOptions> }>({
			configurationState: [
				async ({}, use) => {
					await use({ ok: true, value: configuration });
				},
				{ scope: 'file' },
			],
		})
		.extend(apiFixtures);
}
export const apiTest = createApiTest();
