import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import knex, { type Knex } from 'knex';
import request from 'supertest';
import config, { getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';

const TABLE = 'directus_translations';
const LANG_A = 'af-ZA';
const LANG_B = 'fo-FO';
const REMOTE_VENDOR = 'postgres';
const MIN_VERSION = '1.6.0';
const CLI_TIMEOUT = 25000;

const databases = new Map<string, Knex>();
const baselines = new Map<string, Array<Record<string, unknown>>>();

function auth(): string {
	return `Bearer ${common.USER.ADMIN.TOKEN}`;
}

type TranslationsDoc = { language: string; translations: Record<string, string> };

function translationsConfig(docs: TranslationsDoc[]): unknown {
	return {
		manifest: { version: 2, resources: ['translations'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations: docs,
	};
}

function apply(vendor: string, desired: unknown, options: { destructive?: boolean; dryRun?: boolean } = {}) {
	const req = request(getUrl(vendor))
		.post('/config/apply')
		.set('Authorization', auth())
		.set('Content-Type', 'application/json');

	if (options.destructive) req.query({ destructive: 'true' });
	if (options.dryRun) req.query({ dry_run: 'true' });

	return req.send(desired as object);
}

function errorCodes(response: { body: { errors?: unknown } }): string[] {
	const errors = response.body.errors;
	if (!Array.isArray(errors)) return [];
	return errors.map((error: any) => String(error?.extensions?.code ?? ''));
}

async function seed(vendor: string, row: { language: string; key: string; value: string }) {
	const res = await request(getUrl(vendor)).post('/translations').set('Authorization', auth()).send(row);
	expect(res.status).toBe(200);
}

async function snapshotDocs(vendor: string): Promise<{ snapshot: any; docs: TranslationsDoc[] }> {
	const res = await request(getUrl(vendor)).get('/config/snapshot').set('Authorization', auth());
	expect(res.statusCode).toBe(200);
	return { snapshot: res.body.data, docs: (res.body.data.translations ?? []) as TranslationsDoc[] };
}

function docFor(docs: TranslationsDoc[], language: string): TranslationsDoc | undefined {
	return docs.find((entry) => entry.language === language);
}

async function rows(vendor: string, where: Record<string, unknown> = {}): Promise<Array<Record<string, any>>> {
	return databases.get(vendor)!(TABLE).where(where);
}

async function keysFor(vendor: string, language: string): Promise<string[]> {
	return (await rows(vendor, { language })).map((row) => row.key).sort();
}

async function valuesFor(vendor: string, language: string): Promise<Record<string, string>> {
	const map: Record<string, string> = {};

	for (const row of await rows(vendor, { language })) {
		Object.defineProperty(map, row.key, { value: row.value, enumerable: true, writable: true, configurable: true });
	}

	return map;
}

// Object-literal __proto__ syntax does not create an own property.
function mapWithProto(base: Record<string, string>, protoValue: string): Record<string, string> {
	const map: Record<string, string> = { ...base };
	Object.defineProperty(map, '__proto__', { value: protoValue, enumerable: true, writable: true, configurable: true });
	return map;
}

async function attemptCleanup(failures: string[], label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		failures.push(`${label}: ${(error as Error).message}`);
	}
}

beforeAll(async () => {
	for (const vendor of vendors) {
		const db = knex(config.knexConfig[vendor]!);

		let baseline: Array<Record<string, unknown>>;

		try {
			baseline = await db(TABLE).select('id', 'language', 'key', 'value');
		} catch (error) {
			await db.destroy().catch(() => undefined);
			throw error;
		}

		// Never purge a vendor unless its baseline was captured.
		baselines.set(vendor, baseline);
		databases.set(vendor, db);
		await db(TABLE).del();
	}
});

afterEach(async () => {
	const failures: string[] = [];

	for (const [vendor, db] of databases) {
		await attemptCleanup(failures, `${vendor} purge`, async () => {
			await db(TABLE).del();
		});
	}

	if (failures.length > 0) throw new Error(failures.join('; '));
});

afterAll(async () => {
	const failures: string[] = [];

	for (const [vendor, db] of databases) {
		await attemptCleanup(failures, `${vendor} restore`, async () => {
			const baseline = baselines.get(vendor)!;
			await db(TABLE).del();
			if (baseline.length > 0) await db(TABLE).insert(baseline);

			const restored = await db(TABLE).select('id', 'language', 'key', 'value');

			const serialize = (list: Array<Record<string, unknown>>) =>
				JSON.stringify([...list].sort((a, b) => String(a['id']).localeCompare(String(b['id']))));

			if (serialize(restored) !== serialize(baseline)) {
				throw new Error(`restored rows do not match the captured baseline for ${vendor}`);
			}
		});

		await attemptCleanup(failures, `${vendor} destroy`, async () => {
			await db.destroy();
		});
	}

	if (failures.length > 0) throw new Error(failures.join('; '));
});

describe('Config-as-Code translations round-trip', () => {
	it.each(vendors)('%s creates, snapshots the exact map, and re-applies as a no-op', async (vendor) => {
		const created = await apply(
			vendor,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(created.statusCode).toBe(200);
		expect(created.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

		const { docs } = await snapshotDocs(vendor);
		expect(docFor(docs, LANG_A)?.translations).toEqual({ greeting: 'Hello', farewell: 'Goodbye' });

		const reapply = await apply(
			vendor,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(reapply.statusCode).toBe(200);
		expect(reapply.body.data.translations).toEqual({ created: 0, updated: 0, deleted: 0 });
	});

	it.each(vendors)('%s updates a single value and leaves the rest untouched', async (vendor) => {
		const setup = await apply(
			vendor,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(setup.statusCode).toBe(200);
		expect(setup.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

		const updated = await apply(
			vendor,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hi', farewell: 'Goodbye' } }])
		);

		expect(updated.statusCode).toBe(200);
		expect(updated.body.data.translations).toEqual({ created: 0, updated: 1, deleted: 0 });

		const { docs } = await snapshotDocs(vendor);
		expect(docFor(docs, LANG_A)?.translations).toEqual({ greeting: 'Hi', farewell: 'Goodbye' });
	});
});

describe('Config-as-Code translations complete-set deletion', () => {
	it.each(vendors)(
		'%s gates a combined update and deletion on --destructive, applying neither until authorized',
		async (vendor) => {
			const setup = await apply(
				vendor,
				translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
			);

			expect(setup.statusCode).toBe(200);
			expect(setup.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

			const refused = await apply(vendor, translationsConfig([{ language: LANG_A, translations: { greeting: 'Hi' } }]));

			expect(refused.statusCode).toBe(400);
			expect(errorCodes(refused)).toContain('DESTRUCTIVE_CHANGES_REQUIRED');
			expect(await valuesFor(vendor, LANG_A)).toEqual({ greeting: 'Hello', farewell: 'Goodbye' });

			const authorized = await apply(
				vendor,
				translationsConfig([{ language: LANG_A, translations: { greeting: 'Hi' } }]),
				{ destructive: true }
			);

			expect(authorized.statusCode).toBe(200);
			expect(authorized.body.data.translations).toEqual({ created: 0, updated: 1, deleted: 1 });
			expect(await valuesFor(vendor, LANG_A)).toEqual({ greeting: 'Hi' });
		}
	);

	it.each(vendors)(
		'%s gates dropping a whole language on --destructive and preserves other languages',
		async (vendor) => {
			const setup = await apply(
				vendor,
				translationsConfig([
					{ language: LANG_A, translations: { greeting: 'Hello' } },
					{ language: LANG_B, translations: { greeting: 'Hallo' } },
				])
			);

			expect(setup.statusCode).toBe(200);
			expect(setup.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

			const refused = await apply(
				vendor,
				translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello' } }])
			);

			expect(refused.statusCode).toBe(400);
			expect(errorCodes(refused)).toContain('DESTRUCTIVE_CHANGES_REQUIRED');
			expect(await valuesFor(vendor, LANG_A)).toEqual({ greeting: 'Hello' });
			expect(await valuesFor(vendor, LANG_B)).toEqual({ greeting: 'Hallo' });

			const authorized = await apply(
				vendor,
				translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello' } }]),
				{ destructive: true }
			);

			expect(authorized.statusCode).toBe(200);
			expect(authorized.body.data.translations).toEqual({ created: 0, updated: 0, deleted: 1 });
			expect(await valuesFor(vendor, LANG_A)).toEqual({ greeting: 'Hello' });
			expect(await valuesFor(vendor, LANG_B)).toEqual({});
		}
	);
});

describe('Config-as-Code translations arbitrary keys', () => {
	it.each(vendors)('%s round-trips empty-string and __proto__ keys as own properties', async (vendor) => {
		const map = mapWithProto({ '': 'blank-key-value', normal: 'n' }, 'proto-value');

		const created = await apply(vendor, translationsConfig([{ language: LANG_A, translations: map }]));
		expect(created.statusCode).toBe(200);
		expect(created.body.data.translations).toEqual({ created: 3, updated: 0, deleted: 0 });

		const { docs } = await snapshotDocs(vendor);
		const stored = docFor(docs, LANG_A)!.translations;

		expect(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value).toBe('proto-value');
		expect(stored['']).toBe('blank-key-value');
		expect(stored['normal']).toBe('n');
	});
});

describe('Config-as-Code translations catalogue enforcement', () => {
	it.each(vendors)('%s refuses an authored language absent from the catalogue and stores nothing', async (vendor) => {
		const refused = await apply(vendor, translationsConfig([{ language: 'made-up', translations: { a: '1' } }]));

		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('CONFIG_INVALID');
		expect(await rows(vendor, { language: 'made-up' })).toHaveLength(0);
	});

	it.each(vendors)('%s fails the snapshot read on a stored non-catalogue language', async (vendor) => {
		const db = databases.get(vendor)!;
		await db(TABLE).insert({ id: randomUUID(), language: 'made-up', key: 'a', value: '1' });

		try {
			const res = await request(getUrl(vendor)).get('/config/snapshot').set('Authorization', auth());

			expect(res.statusCode).toBe(500);
			expect(errorCodes(res)).toContain('CONFIG_READ_FAILED');
			expect(await rows(vendor, { language: 'made-up' })).toHaveLength(1);
		} finally {
			await db(TABLE).where({ language: 'made-up' }).del();
		}
	});
});

describe('Config-as-Code translations validation', () => {
	it.each(vendors)('%s refuses a duplicate language document before any mutation', async (vendor) => {
		const duplicate = await apply(
			vendor,
			translationsConfig([
				{ language: LANG_A, translations: { a: '1' } },
				{ language: LANG_A, translations: { b: '2' } },
			])
		);

		expect(duplicate.statusCode).toBe(400);
		expect(errorCodes(duplicate)).toContain('CONFIG_IDENTITY_CONFLICT');
		expect(await rows(vendor)).toHaveLength(0);
	});

	it.each(vendors)('%s refuses a non-string value and stores nothing', async (vendor) => {
		const invalid = await apply(
			vendor,
			translationsConfig([{ language: LANG_A, translations: { a: 5 as unknown as string } }])
		);

		expect(invalid.statusCode).toBe(400);
		expect(errorCodes(invalid)).toContain('CONFIG_INVALID');
		expect(await rows(vendor)).toHaveLength(0);
	});
});

describe('Config-as-Code translations manifest v1 rejection', () => {
	it.each(vendors)('%s refuses translations at manifest version 1 and changes nothing', async (vendor) => {
		const unsupported = await apply(vendor, {
			manifest: { version: 1, resources: ['translations'] },
			roles: [],
			permissions: [],
		});

		expect(unsupported.statusCode).toBe(400);
		expect(errorCodes(unsupported)).toContain('CONFIG_UNSUPPORTED_VERSION');

		const carriedKey = await apply(vendor, {
			manifest: { version: 1, resources: [] },
			roles: [],
			permissions: [],
			translations: [{ language: LANG_A, translations: { a: '1' } }],
		});

		expect(carriedKey.statusCode).toBe(400);
		expect(errorCodes(carriedKey)).toContain('CONFIG_INVALID');
		expect(await rows(vendor)).toHaveLength(0);
	});
});

describe('Config-as-Code translations local CLI', () => {
	async function writeConfigDir(root: string, doc: TranslationsDoc): Promise<void> {
		await fs.writeFile(path.join(root, 'cairncms-config.yaml'), dumpYaml({ version: 2, resources: ['translations'] }));
		await fs.mkdir(path.join(root, 'translations'), { recursive: true });
		await fs.writeFile(path.join(root, 'translations', `${doc.language}.yaml`), dumpYaml(doc));
	}

	function runCli(args: string[], env: NodeJS.ProcessEnv) {
		return spawnSync('node', ['--no-node-snapshot', paths.cli, ...args], {
			cwd: paths.cwd,
			env,
			encoding: 'utf8',
			timeout: CLI_TIMEOUT,
		});
	}

	it.each(vendors)('%s snapshots each language to its literal filename with a flat map', async (vendor) => {
		await seed(vendor, { language: LANG_A, key: 'greeting', value: 'Hello' });
		await seed(vendor, { language: LANG_A, key: 'farewell', value: 'Goodbye' });

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-cli-'));

		try {
			const snapshot = runCli(['config', 'snapshot', dir, '--yes'], {
				...config.envs[vendor as keyof typeof config.envs],
			});

			expect(snapshot.error).toBeUndefined();
			expect(snapshot.status).toBe(0);

			const written = loadYaml(
				await fs.readFile(path.join(dir, 'translations', `${LANG_A}.yaml`), 'utf8')
			) as TranslationsDoc;

			expect(written.language).toBe(LANG_A);
			expect(written.translations).toEqual({ greeting: 'Hello', farewell: 'Goodbye' });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.each(vendors)('%s applies a translations-scoped directory and preserves it on re-snapshot', async (vendor) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-apply-'));

		try {
			await writeConfigDir(dir, { language: LANG_A, translations: { greeting: 'Hello', welcome: 'Welcome' } });

			const applied = runCli(['config', 'apply', dir, '--yes'], { ...config.envs[vendor as keyof typeof config.envs] });
			expect(applied.error).toBeUndefined();
			expect(applied.status).toBe(0);

			expect(await keysFor(vendor, LANG_A)).toEqual(['greeting', 'welcome']);

			const snapshot = runCli(['config', 'snapshot', dir, '--yes'], {
				...config.envs[vendor as keyof typeof config.envs],
			});

			expect(snapshot.error).toBeUndefined();
			expect(snapshot.status).toBe(0);

			const written = loadYaml(
				await fs.readFile(path.join(dir, 'translations', `${LANG_A}.yaml`), 'utf8')
			) as TranslationsDoc;

			expect(written.translations).toEqual({ greeting: 'Hello', welcome: 'Welcome' });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('Config-as-Code translations remote CLI', () => {
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
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-remote-'));
		const { certPath, keyPath } = generateCert(workDir);
		const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
		proxy = await startProxy(cert, key, getUrl(REMOTE_VENDOR));
		proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

		trustedEnv = {
			...config.envs[REMOTE_VENDOR],
			CAIRNCMS_TOKEN: common.USER.ADMIN.TOKEN,
			NODE_EXTRA_CA_CERTS: certPath,
		};
	});

	afterAll(async () => {
		if (!runsRemote) return;
		await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
		if (workDir) await fs.rm(workDir, { recursive: true, force: true });
	});

	(runsRemote ? it : it.skip)(
		'snapshots a language file and applies an update over the wire',
		async () => {
			await seed(REMOTE_VENDOR, { language: LANG_A, key: 'greeting', value: 'Hello' });

			const fixture = path.join(workDir!, 'config');
			await fs.mkdir(fixture, { recursive: true });

			const snapshot = await runCli(['config', 'snapshot', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
			expect(snapshot.status).toBe(0);

			const written = loadYaml(
				await fs.readFile(path.join(fixture, 'translations', `${LANG_A}.yaml`), 'utf8')
			) as TranslationsDoc;

			expect(written.translations).toEqual({ greeting: 'Hello' });

			await fs.writeFile(
				path.join(fixture, 'cairncms-config.yaml'),
				dumpYaml({ version: 2, resources: ['translations'] })
			);

			await fs.writeFile(
				path.join(fixture, 'translations', `${LANG_A}.yaml`),
				dumpYaml({ language: LANG_A, translations: { greeting: 'Hi' } })
			);

			const applied = await runCli(['config', 'apply', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
			expect(applied.status).toBe(0);

			const stored = await rows(REMOTE_VENDOR, { language: LANG_A });
			expect(stored).toHaveLength(1);
			expect(stored[0]!.value).toBe('Hi');
		},
		120000
	);
});
