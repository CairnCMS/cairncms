import request from 'supertest';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import config, { getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';

type Settings = Record<string, any>;

type ConfigSnapshot = {
	manifest: { version: number; resources: string[] };
	roles: Array<Record<string, any>>;
	permissions: Array<{ role: string; permissions: Array<Record<string, any>> }>;
	folders?: Array<Record<string, any>>;
	settings?: Settings[];
	'extension-settings'?: Settings[];
	translations?: Settings[];
};

const REMOTE_VENDOR = 'postgres';
const MIN_VERSION = '1.6.0';
const CLI_TIMEOUT = 25000;

function token(): string {
	return `Bearer ${common.USER.ADMIN!.TOKEN}`;
}

async function httpSnapshot(vendor: string): Promise<ConfigSnapshot> {
	const response = await request(getUrl(vendor)).get('/config/snapshot').set('Authorization', token());
	expect(response.statusCode).toBe(200);
	return response.body.data as ConfigSnapshot;
}

async function httpSettings(vendor: string): Promise<Settings> {
	return (await httpSnapshot(vendor)).settings![0]!;
}

function applyConfig(vendor: string, desired: unknown, options: { destructive?: boolean; dryRun?: boolean } = {}) {
	const req = request(getUrl(vendor))
		.post('/config/apply')
		.set('Authorization', token())
		.set('Content-Type', 'application/json');

	if (options.destructive) req.query({ destructive: 'true' });
	if (options.dryRun) req.query({ dry_run: 'true' });

	return req.send(desired as object);
}

function settingsOnly(settings: Settings): ConfigSnapshot {
	return {
		manifest: { version: 2, resources: ['settings'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [settings],
		'extension-settings': [],
		translations: [],
	};
}

function foldersAndSettings(folders: Array<Record<string, any>>, settings: Settings): ConfigSnapshot {
	return {
		manifest: { version: 2, resources: ['folders', 'settings'] },
		roles: [],
		permissions: [],
		folders,
		settings: [settings],
		'extension-settings': [],
		translations: [],
	};
}

function errorCodes(response: { body: { errors?: unknown } }): string[] {
	const errors = response.body.errors;
	if (!Array.isArray(errors)) return [];
	return errors.map((error: any) => String(error?.extensions?.code ?? ''));
}

async function folderIdByKey(vendor: string, key: string): Promise<string | undefined> {
	const response = await request(getUrl(vendor))
		.get('/folders')
		.query({ filter: JSON.stringify({ key: { _eq: key } }), fields: 'id' })
		.set('Authorization', token());

	expect(response.statusCode).toBe(200);
	return response.body.data[0]?.id as string | undefined;
}

async function deleteFolderByKey(vendor: string, key: string): Promise<void> {
	const id = await folderIdByKey(vendor, key);
	if (id === undefined) return;
	const del = await request(getUrl(vendor)).delete(`/folders/${id}`).set('Authorization', token());
	if (del.statusCode !== 200 && del.statusCode !== 204) throw new Error(`folder delete returned ${del.statusCode}`);
}

async function rawSettings(vendor: string): Promise<Record<string, any>> {
	const response = await request(getUrl(vendor)).get('/settings').set('Authorization', token());
	expect(response.statusCode).toBe(200);
	return response.body.data;
}

// Unset nullable fields may read as undefined; PATCH must send null or JSON would omit the clear.
const norm = (value: unknown): unknown => value ?? null;

// The ordinary settings API needs folder IDs, not the keys emitted by config snapshots.
async function patchRestore(vendor: string, rawBaseline: Record<string, any>, fields: string[]): Promise<void> {
	const patch: Record<string, any> = {};
	for (const field of fields) patch[field] = norm(rawBaseline[field]);
	const response = await request(getUrl(vendor)).patch('/settings').set('Authorization', token()).send(patch);
	if (response.statusCode !== 200) throw new Error(`settings restore fallback returned ${response.statusCode}`);
}

/**
 * Cleanup verification and fallback use the ordinary API so a broken config path cannot prevent restoration.
 */
async function restoreSettings(
	vendor: string,
	baseline: Settings,
	rawBaseline: Record<string, any>,
	fields: string[]
): Promise<void> {
	const desired: Settings = {};
	for (const field of fields) desired[field] = baseline[field];

	const verifiedRaw = async (): Promise<boolean> => {
		const response = await request(getUrl(vendor)).get('/settings').set('Authorization', token());
		if (response.statusCode !== 200) return false;
		const current = response.body.data;
		return fields.every((field) => JSON.stringify(norm(current[field])) === JSON.stringify(norm(rawBaseline[field])));
	};

	let restored = false;

	try {
		const response = await applyConfig(vendor, settingsOnly(desired), { destructive: false });
		restored = response.statusCode === 200 && (await verifiedRaw());
	} catch {
		restored = false;
	}

	if (!restored) await patchRestore(vendor, rawBaseline, fields);

	const current = await rawSettings(vendor);
	for (const field of fields) expect(norm(current[field])).toEqual(norm(rawBaseline[field]));
}

function reportOutcome(testError: unknown, failures: string[]): void {
	if (testError !== undefined) {
		if (failures.length > 0) {
			throw new Error(
				`${(testError as Error)?.message ?? String(testError)} (cleanup also failed: ${failures.join('; ')})`
			);
		}

		throw testError;
	}

	if (failures.length > 0) throw new Error(failures.join('; '));
}

async function attemptCleanup(failures: string[], label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		failures.push(`${label}: ${(error as Error).message}`);
	}
}

describe('Config-as-Code settings round-trip', () => {
	it.each(vendors)(
		'%s exercises the string, number, and json-array field types with omission and null controls',
		async (vendor) => {
			const baseline = await httpSettings(vendor);
			const rawBaseline = await rawSettings(vendor);
			const fields = ['project_descriptor', 'auth_login_attempts', 'storage_asset_presets'];
			let testError: unknown;
			const failures: string[] = [];

			try {
				const presets = [
					{ key: 'thumb', fit: 'cover', width: 100, height: 100 },
					{ key: 'wide', fit: 'contain', width: 800, height: 400 },
				];

				const applied = await applyConfig(
					vendor,
					settingsOnly({
						project_descriptor: 'Blackbox descriptor',
						auth_login_attempts: 7,
						storage_asset_presets: presets,
					})
				);

				expect(applied.statusCode).toBe(200);
				expect(applied.body.data.settings).toEqual({ updated: ['project'] });

				const afterSet = await httpSettings(vendor);
				expect(afterSet.project_descriptor).toBe('Blackbox descriptor');
				expect(afterSet.auth_login_attempts).toBe(7);
				expect(afterSet.storage_asset_presets).toEqual(presets);

				const preserved = await applyConfig(vendor, settingsOnly({ project_descriptor: 'Renamed descriptor' }));
				expect(preserved.statusCode).toBe(200);

				const afterOmit = await httpSettings(vendor);
				expect(afterOmit.project_descriptor).toBe('Renamed descriptor');
				expect(afterOmit.auth_login_attempts).toBe(7);
				expect(afterOmit.storage_asset_presets).toEqual(presets);

				const cleared = await applyConfig(
					vendor,
					settingsOnly({ project_descriptor: null, storage_asset_presets: [] })
				);

				expect(cleared.statusCode).toBe(200);

				const afterClear = await httpSettings(vendor);
				expect(afterClear.project_descriptor).toBeNull();
				expect(afterClear.storage_asset_presets).toEqual([]);

				const nulledArray = await applyConfig(vendor, settingsOnly({ storage_asset_presets: null }));
				expect(nulledArray.statusCode).toBe(200);
				expect((await httpSettings(vendor)).storage_asset_presets).toBeNull();
			} catch (error) {
				testError = error;
			}

			await attemptCleanup(failures, 'restore settings', () => restoreSettings(vendor, baseline, rawBaseline, fields));
			reportOutcome(testError, failures);
		}
	);
});

describe('Config-as-Code settings cleanup fallback', () => {
	it.each(vendors)(
		'%s clears a changed field through the settings-API fallback when the baseline value is unset',
		async (vendor) => {
			const rawBaseline = await rawSettings(vendor);
			let testError: unknown;
			const failures: string[] = [];

			try {
				const changed = await request(getUrl(vendor))
					.patch('/settings')
					.set('Authorization', token())
					.send({ project_descriptor: 'Fallback probe value' });

				expect(changed.statusCode).toBe(200);

				// Force an unset baseline regardless of the instance's existing descriptor.
				await patchRestore(vendor, {}, ['project_descriptor']);

				expect(norm((await rawSettings(vendor)).project_descriptor)).toBeNull();
			} catch (error) {
				testError = error;
			}

			await attemptCleanup(failures, 'restore settings', () =>
				patchRestore(vendor, rawBaseline, ['project_descriptor'])
			);

			reportOutcome(testError, failures);
		}
	);
});

describe('Config-as-Code settings manifest v1 rejection', () => {
	it.each(vendors)('%s refuses settings at manifest version 1 and changes nothing', async (vendor) => {
		const before = await httpSettings(vendor);

		const badManifest = await applyConfig(vendor, {
			manifest: { version: 1, resources: ['settings'] },
			roles: [],
			permissions: [],
		});

		expect(badManifest.statusCode).toBe(400);
		expect(errorCodes(badManifest)).toContain('CONFIG_UNSUPPORTED_VERSION');

		// Empty scope rules out unrelated admin-continuity and deletion refusals.
		const carriedKey = await applyConfig(vendor, {
			manifest: { version: 1, resources: [] },
			roles: [],
			permissions: [],
			settings: [{ project_descriptor: 'should not apply' }],
		});

		expect(carriedKey.statusCode).toBe(400);
		expect(errorCodes(carriedKey)).toContain('CONFIG_INVALID');
		expect(await httpSettings(vendor)).toEqual(before);
	});
});

describe('Config-as-Code settings default folder', () => {
	it.each(vendors)(
		'%s round-trips the default folder by key and hands off create -> retarget -> delete in one apply',
		async (vendor) => {
			const run = randomUUID().replace(/-/g, '').slice(0, 8);
			const first = `settings_${run}_first`;
			const second = `settings_${run}_second`;
			const baseline = await httpSettings(vendor);
			const rawBaseline = await rawSettings(vendor);
			const baseFolders = (await httpSnapshot(vendor)).folders ?? [];
			let testError: unknown;
			const failures: string[] = [];

			try {
				// Building on the live folder set keeps a destructive apply from deleting pre-existing folders.
				const created = await applyConfig(
					vendor,
					foldersAndSettings([...baseFolders, { key: first, name: 'First', parent: null }], {
						storage_default_folder: first,
					})
				);

				expect(created.statusCode).toBe(200);
				expect((await httpSettings(vendor)).storage_default_folder).toBe(first);

				const handed = await applyConfig(
					vendor,
					foldersAndSettings([...baseFolders, { key: second, name: 'Second', parent: null }], {
						storage_default_folder: second,
					}),
					{ destructive: true }
				);

				expect(handed.statusCode).toBe(200);
				expect((await httpSettings(vendor)).storage_default_folder).toBe(second);
				expect(await folderIdByKey(vendor, first)).toBeUndefined();
			} catch (error) {
				testError = error;
			}

			await attemptCleanup(failures, 'restore settings', () =>
				restoreSettings(vendor, baseline, rawBaseline, ['storage_default_folder'])
			);

			await attemptCleanup(failures, 'delete first folder', () => deleteFolderByKey(vendor, first));
			await attemptCleanup(failures, 'delete second folder', () => deleteFolderByKey(vendor, second));
			reportOutcome(testError, failures);
		}
	);

	it.each(vendors)(
		'%s refuses to delete a folder the preserved default still references and rolls the whole apply back',
		async (vendor) => {
			const run = randomUUID().replace(/-/g, '').slice(0, 8);
			const doomed = `settings_${run}_doomed`;
			const baseline = await httpSettings(vendor);
			const rawBaseline = await rawSettings(vendor);
			const baseFolders = (await httpSnapshot(vendor)).folders ?? [];
			let testError: unknown;
			const failures: string[] = [];

			try {
				const seeded = await applyConfig(
					vendor,
					foldersAndSettings([...baseFolders, { key: doomed, name: 'Doomed', parent: null }], {
						storage_default_folder: doomed,
						project_descriptor: 'Seed',
					})
				);

				expect(seeded.statusCode).toBe(200);

				// Omit the default-folder field to reach the live guard; an explicit dangling reference fails validation.
				const refused = await applyConfig(
					vendor,
					foldersAndSettings([...baseFolders], { project_descriptor: 'Should roll back' }),
					{
						destructive: true,
					}
				);

				expect(refused.statusCode).toBe(400);
				expect(errorCodes(refused)).toContain('CONFIG_FOLDER_IN_USE');
				expect(refused.body.errors[0].extensions.blockedBy).toBe('storage_default_folder');

				expect(await folderIdByKey(vendor, doomed)).toBeDefined();

				const persisted = await httpSettings(vendor);
				expect(persisted.storage_default_folder).toBe(doomed);
				expect(persisted.project_descriptor).toBe('Seed');
			} catch (error) {
				testError = error;
			}

			await attemptCleanup(failures, 'restore settings', () =>
				restoreSettings(vendor, baseline, rawBaseline, ['storage_default_folder', 'project_descriptor'])
			);

			await attemptCleanup(failures, 'delete doomed folder', () => deleteFolderByKey(vendor, doomed));
			reportOutcome(testError, failures);
		}
	);
});

describe('Config-as-Code settings file-field exclusion', () => {
	it.each(vendors)('%s omits file-reference settings from the snapshot and refuses one on apply', async (vendor) => {
		const settings = await httpSettings(vendor);

		expect(settings).not.toHaveProperty('project_logo');
		expect(settings).not.toHaveProperty('public_foreground');
		expect(settings).not.toHaveProperty('public_background');

		const before = await httpSettings(vendor);
		const refused = await applyConfig(vendor, settingsOnly({ project_logo: randomUUID() }));

		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('CONFIG_INVALID');
		expect(JSON.stringify(refused.body)).toContain('project_logo');
		expect(await httpSettings(vendor)).toEqual(before);
	});
});

describe('Config-as-Code settings placeholder preservation', () => {
	const PLACEHOLDER = '{{CAIRNCMS_CONFIG_PROJECT_DESCRIPTOR}}';

	async function writeSettingsFixture(root: string, descriptor: string): Promise<void> {
		await fs.writeFile(path.join(root, 'cairncms-config.yaml'), dumpYaml({ version: 2, resources: ['settings'] }));
		await fs.mkdir(path.join(root, 'settings'), { recursive: true });
		await fs.writeFile(path.join(root, 'settings', 'project.yaml'), dumpYaml({ project_descriptor: descriptor }));
	}

	async function readWrittenSettings(root: string): Promise<Record<string, any>> {
		return loadYaml(await fs.readFile(path.join(root, 'settings', 'project.yaml'), 'utf8')) as Record<string, any>;
	}

	it.each(vendors)(
		'%s keeps a committed placeholder on a local CLI snapshot while HTTP returns the stored value',
		async (vendor) => {
			const baseline = await httpSettings(vendor);
			const rawBaseline = await rawSettings(vendor);
			const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-settings-cli-'));
			let testError: unknown;
			const failures: string[] = [];

			try {
				const stored = await applyConfig(vendor, settingsOnly({ project_descriptor: 'Stored database value' }));
				expect(stored.statusCode).toBe(200);

				await writeSettingsFixture(fixture, PLACEHOLDER);

				const env = { ...config.envs[vendor as keyof typeof config.envs] };
				delete env['CAIRNCMS_CONFIG_PROJECT_DESCRIPTOR'];

				const snapshot = spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'snapshot', fixture, '--yes'], {
					cwd: paths.cwd,
					env,
					encoding: 'utf8',
					timeout: CLI_TIMEOUT,
				});

				expect(snapshot.error).toBeUndefined();
				expect(snapshot.status).toBe(0);

				const written = await readWrittenSettings(fixture);
				expect(written.project_descriptor).toBe(PLACEHOLDER);
				// The seeded file lacks this field, so a no-op snapshot cannot satisfy the assertion.
				expect(written.project_name).toBe(baseline.project_name);

				expect((await httpSettings(vendor)).project_descriptor).toBe('Stored database value');
			} catch (error) {
				testError = error;
			}

			await attemptCleanup(failures, 'restore settings', () =>
				restoreSettings(vendor, baseline, rawBaseline, ['project_descriptor'])
			);

			await attemptCleanup(failures, 'remove fixture', () => fs.rm(fixture, { recursive: true, force: true }));
			reportOutcome(testError, failures);
		}
	);

	describe('remote CLI', () => {
		const runsRemote = vendors.includes(REMOTE_VENDOR);
		let workDir: string | undefined;
		let proxy: https.Server | undefined;
		let proxyUrl: string;
		let trustedEnv: NodeJS.ProcessEnv;

		function generateCert(dir: string): { certPath: string; keyPath: string } {
			const certPath = path.join(dir, 'cert.pem');
			const keyPath = path.join(dir, 'key.pem');

			const result = spawnSync(
				'openssl',
				[
					'req',
					'-x509',
					'-newkey',
					'rsa:2048',
					'-nodes',
					'-keyout',
					keyPath,
					'-out',
					certPath,
					'-days',
					'1',
					'-subj',
					'/CN=127.0.0.1',
					'-addext',
					'subjectAltName=IP:127.0.0.1',
				],
				{ encoding: 'utf8' }
			);

			if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
			return { certPath, keyPath };
		}

		function rewriteVersion(req: http.IncomingMessage, payload: Buffer): Buffer {
			if ((req.url ?? '').split('?')[0] === '/server/info' && req.method === 'GET') {
				try {
					const parsed = JSON.parse(payload.toString('utf8'));
					if (parsed?.data?.cairncms) parsed.data.cairncms.version = MIN_VERSION;
					return Buffer.from(JSON.stringify(parsed));
				} catch {
					return payload;
				}
			}

			return payload;
		}

		function startProxy(cert: Buffer, key: Buffer, upstream: string): Promise<https.Server> {
			const target = new URL(upstream);

			const server = https.createServer({ cert, key }, (req, res) => {
				const chunks: Buffer[] = [];
				req.on('data', (chunk) => chunks.push(chunk));

				req.on('end', () => {
					const body = Buffer.concat(chunks);
					const headers = { ...req.headers };
					delete headers['accept-encoding'];
					delete headers['host'];

					const upstreamReq = http.request(
						{ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers },
						(upstreamRes) => {
							const responseChunks: Buffer[] = [];
							upstreamRes.on('data', (chunk) => responseChunks.push(chunk));

							upstreamRes.on('end', () => {
								const payload = rewriteVersion(req, Buffer.concat(responseChunks));
								const responseHeaders = { ...upstreamRes.headers };
								delete responseHeaders['content-length'];
								res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
								res.end(payload);
							});
						}
					);

					upstreamReq.on('error', () => {
						res.writeHead(502);
						res.end();
					});

					if (body.length > 0) upstreamReq.write(body);
					upstreamReq.end();
				});
			});

			return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
		}

		function runCli(
			args: string[],
			env: NodeJS.ProcessEnv
		): Promise<{ status: number | null; stdout: string; stderr: string }> {
			return new Promise((resolve, reject) => {
				const child = spawn('node', ['--no-node-snapshot', paths.cli, ...args], { cwd: paths.cwd, env });
				let stdout = '';
				let stderr = '';
				let timedOut = false;
				child.stdout.on('data', (chunk) => (stdout += chunk));
				child.stderr.on('data', (chunk) => (stderr += chunk));

				const timer = setTimeout(() => {
					timedOut = true;
					child.kill('SIGKILL');
				}, CLI_TIMEOUT);

				child.on('error', (err) => {
					clearTimeout(timer);
					reject(err);
				});

				child.on('close', (status) => {
					clearTimeout(timer);
					if (timedOut) reject(new Error(`CLI timed out: config ${args.join(' ')}`));
					else resolve({ status, stdout, stderr });
				});
			});
		}

		beforeAll(async () => {
			if (!runsRemote) return;
			workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-settings-remote-'));
			const { certPath, keyPath } = generateCert(workDir);
			const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
			proxy = await startProxy(cert, key, getUrl(REMOTE_VENDOR));
			proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

			trustedEnv = {
				...config.envs[REMOTE_VENDOR],
				CAIRNCMS_TOKEN: common.USER.ADMIN!.TOKEN,
				NODE_EXTRA_CA_CERTS: certPath,
			};

			delete trustedEnv['CAIRNCMS_CONFIG_PROJECT_DESCRIPTOR'];
		});

		afterAll(async () => {
			if (!runsRemote) return;

			await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
			if (workDir) await fs.rm(workDir, { recursive: true, force: true });
		});

		(runsRemote ? it : it.skip)(
			'keeps a committed placeholder on a remote CLI snapshot',
			async () => {
				const baseline = await httpSettings(REMOTE_VENDOR);
				const rawBaseline = await rawSettings(REMOTE_VENDOR);
				const fixture = path.join(workDir!, 'config');
				await fs.mkdir(fixture, { recursive: true });
				let testError: unknown;
				const failures: string[] = [];

				try {
					const stored = await applyConfig(REMOTE_VENDOR, settingsOnly({ project_descriptor: 'Remote stored value' }));
					expect(stored.statusCode).toBe(200);

					await writeSettingsFixture(fixture, PLACEHOLDER);

					const snapshot = await runCli(['config', 'snapshot', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
					expect(snapshot.status).toBe(0);

					const written = await readWrittenSettings(fixture);
					expect(written.project_descriptor).toBe(PLACEHOLDER);
					expect(written.project_name).toBe(baseline.project_name);
				} catch (error) {
					testError = error;
				}

				await attemptCleanup(failures, 'restore settings', () =>
					restoreSettings(REMOTE_VENDOR, baseline, rawBaseline, ['project_descriptor'])
				);

				reportOutcome(testError, failures);
			},
			120000
		);
	});
});
