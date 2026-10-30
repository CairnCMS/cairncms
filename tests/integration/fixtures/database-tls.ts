import { inject } from 'vitest';
import { Wait, getContainerRuntimeClient } from 'testcontainers';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { withService } from './service';
import { createEnvironmentTest, apiFixtures, type EnvironmentOptions, type Runtime } from './environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';
import { databaseVendors } from '../harness/database-vendors.mjs';
import {
	createTlsCertificates,
	tlsServiceDefinition,
	registerTlsResource,
	tlsEnvironment,
} from '../harness/database-tls.mjs';
import { removeMarkedDirectory } from '../harness/owned-directory.mjs';
import { ownCli } from '../harness/owned-cli.mjs';

export type TlsProfile =
	| 'verified'
	| 'ca-file'
	| 'wrong-ca'
	| 'plaintext'
	| 'connection-string'
	| 'connection-string-wrong-ca'
	| 'verification-disabled'
	| 'wrong-password';
export type TlsProbeResult = {
	ok: boolean;
	value?: number;
	encrypted?: boolean;
	error?: { code?: string; message: string };
	versions: Record<string, string>;
};
export type DatabaseTls = {
	probe: (profile?: TlsProfile) => Promise<TlsProbeResult>;
	available: () => boolean;
	requiresEncryption: boolean;
};

async function stop(child: ChildProcess) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
	child.kill('SIGTERM');
	const force = setTimeout(() => child.kill('SIGKILL'), 5000);

	try {
		await done;
	} finally {
		clearTimeout(force);
	}
}

export async function withDatabaseTls(
	runtime: Runtime,
	signal: AbortSignal,
	use: (resource: DatabaseTls) => Promise<void>,
	options: { mismatch?: boolean } = {}
) {
	const definition = databaseVendors[runtime.vendor as keyof typeof databaseVendors];
	if (!definition || !('image' in definition)) throw new Error('Database TLS requires a server vendor');
	const postgres = definition.family === 'postgres';
	const id = `test_${randomUUID().replaceAll('-', '')}`;
	const directory = join(tmpdir(), `cairn-integration-tls-${id}`);
	const owner = { directory, database: id, owner: process.pid, children: [] as number[] };
	const ownerPath = join(runtime.directory, `${id}.owner.json`);
	const children = new Set<ChildProcess>();
	const errors: unknown[] = [];
	let writes = Promise.resolve();
	let closed = false;

	const save = () =>
		(writes = writes.then(async () => {
			const pids = [...children].flatMap((child) => (child.pid ? [child.pid] : []));
			await writeFile(ownerPath + '.partial', JSON.stringify({ ...owner, children: pids }));
			await rename(ownerPath + '.partial', ownerPath);
		}));

	const track = async (child: ChildProcess) => {
		children.add(child);
		await save();
	};

	const release = async (child: ChildProcess) => {
		children.delete(child);
		await save();
	};

	const abort = () => {
		for (const child of children) void stop(child).catch((error) => errors.push(error));
	};

	signal.addEventListener('abort', abort, { once: true });

	try {
		await save();
		signal.throwIfAborted();
		await mkdir(directory, { mode: 0o700 });
		await writeFile(join(directory, '.integration-owner.json'), JSON.stringify({ id, reports: runtime.directory }));
		const client = await getContainerRuntimeClient();
		const host = client.info.containerRuntime.host;

		const certificates = await createTlsCertificates(directory, host, async (args: string[]) => {
			signal.throwIfAborted();
			let child: ChildProcess;

			const completed = new Promise<Error | null>((resolve) => {
				child = execFile('openssl', args, { signal, timeout: 25000, killSignal: 'SIGKILL' }, resolve);
			});

			const exited = new Promise<void>((resolve) => child!.once('close', () => resolve()));

			try {
				await track(child!);
				const error = await completed;
				if (error) throw error;
			} finally {
				await exited;
				await release(child!);
			}
		});

		const service = tlsServiceDefinition(runtime.vendor, certificates, options.mismatch);

		await withService(
			{
				...service,
				health: ['CMD-SHELL', service.health[1]!],
				wait: Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]),
			},
			runtime.directory,
			signal,
			async (owned) => {
				const connection = {
					host: owned.host,
					port: owned.port,
					user: definition.user,
					password: 'integration',
					ssl: {
						ca: certificates.ca,
						rejectUnauthorized: true,
						...(!postgres ? { verifyIdentity: !options.mismatch } : {}),
						...(postgres && options.mismatch ? { checkServerIdentity: () => undefined } : {}),
					},
				};

				const admin = knex({
					client: definition.client,
					connection: { ...connection, database: definition.database },
					pool: { min: 0, max: 1 },
					acquireConnectionTimeout: 10000,
				});

				try {
					await admin.raw('SELECT 1').timeout(10000);

					const enforcement = postgres
						? true
						: (await admin.raw("SHOW GLOBAL VARIABLES LIKE 'require_secure_transport'").timeout(10000))[0][0].Value ===
						  'ON';

					if (!enforcement) throw new Error('Owned database does not require encrypted transport');

					await admin
						.raw(
							postgres ? 'CREATE DATABASE ??' : 'CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
							[id]
						)
						.timeout(10000);

					const details = {
						vendor: runtime.vendor,
						reports: runtime.directory,
						connection,
						certificates,
						available: () => !closed && owned.available(),
					};

					const resource: DatabaseTls = {
						available: details.available,
						requiresEncryption: enforcement,
						probe: async (profile = 'verified') => {
							signal.throwIfAborted();
							if (!details.available()) throw new Error('Owned TLS database stopped');

							const env = tlsEnvironment(
								details,
								{
									PATH: process.env.PATH,
									NODE_ENV: 'production',
									TZ: 'UTC',
									DB_CLIENT: postgres ? 'pg' : 'mysql',
									DB_HOST: owned.host,
									DB_PORT: String(owned.port),
									DB_USER: definition.user,
									DB_PASSWORD: 'integration',
									DB_DATABASE: id,
									DB_POOL__MIN: '0',
									DB_POOL__MAX: '1',
								},
								profile
							);

							const entry = fileURLToPath(new URL('../harness/database-tls-probe.mjs', import.meta.url));
							const lifetime = fileURLToPath(new URL('../harness/tool-lifetime.mjs', import.meta.url));

							const child = spawn(process.execPath, ['--import', lifetime, entry], {
								cwd: directory,
								env,
								stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
							});

							const logPath = join(runtime.directory, `${id}.${profile}.${randomUUID()}.probe.log`);
							const command = ownCli(child, { stop, diagnostics: logPath });

							try {
								await track(child);
								child.stdin!.end();
								const result = await command.result;
								signal.throwIfAborted();

								const lines = result.stdout
									.split('\n')
									.filter((line: string) => line.startsWith('DATABASE_TLS_RESULT '));

								if (lines.length !== 1)
									throw new Error(`Database TLS probe did not return one result: ${result.stdout}\n${result.stderr}`);
								const value = JSON.parse(lines[0]!.slice('DATABASE_TLS_RESULT '.length)) as TlsProbeResult;
								if (typeof value.ok !== 'boolean' || result.signal || result.status !== (value.ok ? 0 : 1))
									throw new Error('Database TLS probe outcome disagrees with its exit status');
								if (
									value.ok ? value.value !== 42 || value.encrypted !== true : typeof value.error?.message !== 'string'
								)
									throw new Error('Database TLS probe returned an incomplete outcome');
								if (
									['knex', 'pg', 'mysql2', 'pgConnectionString'].some(
										(name) => typeof value.versions?.[name] !== 'string'
									)
								)
									throw new Error('Database TLS probe did not report its API dependency versions');
								return value;
							} finally {
								await stop(child);
								await release(child);
								await writeFile(logPath, command.output());
							}
						},
					};

					registerTlsResource(resource, details);
					await use(resource);
				} catch (error) {
					errors.push(error);
				} finally {
					try {
						await admin.destroy();
					} catch (error) {
						errors.push(error);
					}
				}
			}
		);
	} catch (error) {
		errors.push(error);
	} finally {
		closed = true;
		signal.removeEventListener('abort', abort);

		for (const child of children) {
			try {
				await stop(child);
			} catch (error) {
				errors.push(error);
			}
		}

		try {
			await writes;
		} catch (error) {
			errors.push(error);
		}

		try {
			await removeMarkedDirectory(directory);
		} catch (error) {
			errors.push(error);
		}
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length) throw new AggregateError(errors, 'Database TLS fixture failed');
}

export function createDatabaseTlsTest() {
	return createEnvironmentTest()
		.extend<{
			tlsState: Prerequisite<DatabaseTls>;
			tls: DatabaseTls;
			configurationState: Prerequisite<EnvironmentOptions>;
		}>({
			tlsState: [
				async ({ cancellationSignal, teardownFailures }, use) => {
					await capturePrerequisite(
						(ready) => withDatabaseTls(inject('integration'), cancellationSignal, ready),
						use,
						teardownFailures
					);
				},
				{ scope: 'file' },
			],
			tls: async ({ tlsState, task, skip }, use) => {
				await use(requirePrerequisite(tlsState, 'TLS database', { task, skip }));
			},
			configurationState: [
				async ({ tlsState }, use) => {
					await use(tlsState.ok ? { ok: true, value: { bootstrap: 'fresh', databaseTls: tlsState.value } } : tlsState);
				},
				{ scope: 'file' },
			],
		})
		.extend(apiFixtures);
}
