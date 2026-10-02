import { setupRequest } from '../../fixtures/request';
import { afterEach, describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createScenarioTest } from '../../fixtures/scenario';
import { describeForVendors } from '../../fixtures/applicability';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import request from '../../fixtures/request';
import * as common from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const TABLE = 'directus_translations';
const LANG_A = 'af-ZA';
const LANG_B = 'fo-FO';

const MIN_VERSION = '1.6.0';
const CLI_TIMEOUT = 25000;

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

function apply(api: Api, desired: unknown, options: { destructive?: boolean; dryRun?: boolean } = {}) {
	const req = request(api.url)
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

async function seed(api: Api, row: { language: string; key: string; value: string }) {
	const res = await setupRequest(api.url).post('/translations').set('Authorization', auth()).send(row);
	expect(res.status).toBe(200);
}

async function snapshotDocs(api: Api): Promise<{ snapshot: any; docs: TranslationsDoc[] }> {
	const res = await request(api.url).get('/config/snapshot').set('Authorization', auth());
	expect(res.statusCode).toBe(200);
	return { snapshot: res.body.data, docs: (res.body.data.translations ?? []) as TranslationsDoc[] };
}

function docFor(docs: TranslationsDoc[], language: string): TranslationsDoc | undefined {
	return docs.find((entry) => entry.language === language);
}

async function rows(api: Api, where: Record<string, unknown> = {}): Promise<Array<Record<string, any>>> {
	return api.database(TABLE).where(where);
}

async function keysFor(api: Api, language: string): Promise<string[]> {
	return (await rows(api, { language })).map((row) => row.key).sort();
}

async function valuesFor(api: Api, language: string): Promise<Record<string, string>> {
	const map: Record<string, string> = {};

	for (const row of await rows(api, { language })) {
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

const test = createScenarioTest({
	prepare: async (api) => {
		await api.database(TABLE).delete();
	},
	cleanup: async (api) => {
		await api.database(TABLE).delete();
	},
});

afterEach<{ api: Api }>(async ({ api }) => {
	await api.database(TABLE).delete();
});

describe('Config-as-Code translations round-trip', () => {
	test('creates, snapshots the exact map, and re-applies as a no-op', async ({ api }) => {
		const created = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(created.statusCode).toBe(200);
		expect(created.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

		const { docs } = await snapshotDocs(api);
		expect(docFor(docs, LANG_A)?.translations).toEqual({ greeting: 'Hello', farewell: 'Goodbye' });

		const reapply = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(reapply.statusCode).toBe(200);
		expect(reapply.body.data.translations).toEqual({ created: 0, updated: 0, deleted: 0 });
	});

	test('updates a single value and leaves the rest untouched', async ({ api }) => {
		const setup = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(setup.statusCode).toBe(200);
		expect(setup.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

		const updated = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hi', farewell: 'Goodbye' } }])
		);

		expect(updated.statusCode).toBe(200);
		expect(updated.body.data.translations).toEqual({ created: 0, updated: 1, deleted: 0 });

		const { docs } = await snapshotDocs(api);
		expect(docFor(docs, LANG_A)?.translations).toEqual({ greeting: 'Hi', farewell: 'Goodbye' });
	});
});

describe('Config-as-Code translations complete-set deletion', () => {
	test('gates a combined update and deletion on --destructive, applying neither until authorized', async ({ api }) => {
		const setup = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello', farewell: 'Goodbye' } }])
		);

		expect(setup.statusCode).toBe(200);
		expect(setup.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

		const refused = await apply(api, translationsConfig([{ language: LANG_A, translations: { greeting: 'Hi' } }]));

		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('DESTRUCTIVE_CHANGES_REQUIRED');
		expect(await valuesFor(api, LANG_A)).toEqual({ greeting: 'Hello', farewell: 'Goodbye' });

		const authorized = await apply(api, translationsConfig([{ language: LANG_A, translations: { greeting: 'Hi' } }]), {
			destructive: true,
		});

		expect(authorized.statusCode).toBe(200);
		expect(authorized.body.data.translations).toEqual({ created: 0, updated: 1, deleted: 1 });
		expect(await valuesFor(api, LANG_A)).toEqual({ greeting: 'Hi' });
	});

	test('gates dropping a whole language on --destructive and preserves other languages', async ({ api }) => {
		const setup = await apply(
			api,
			translationsConfig([
				{ language: LANG_A, translations: { greeting: 'Hello' } },
				{ language: LANG_B, translations: { greeting: 'Hallo' } },
			])
		);

		expect(setup.statusCode).toBe(200);
		expect(setup.body.data.translations).toEqual({ created: 2, updated: 0, deleted: 0 });

		const refused = await apply(api, translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello' } }]));

		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('DESTRUCTIVE_CHANGES_REQUIRED');
		expect(await valuesFor(api, LANG_A)).toEqual({ greeting: 'Hello' });
		expect(await valuesFor(api, LANG_B)).toEqual({ greeting: 'Hallo' });

		const authorized = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { greeting: 'Hello' } }]),
			{ destructive: true }
		);

		expect(authorized.statusCode).toBe(200);
		expect(authorized.body.data.translations).toEqual({ created: 0, updated: 0, deleted: 1 });
		expect(await valuesFor(api, LANG_A)).toEqual({ greeting: 'Hello' });
		expect(await valuesFor(api, LANG_B)).toEqual({});
	});
});

describe('Config-as-Code translations arbitrary keys', () => {
	test('round-trips empty-string and __proto__ keys as own properties', async ({ api }) => {
		const map = mapWithProto({ '': 'blank-key-value', normal: 'n' }, 'proto-value');

		const created = await apply(api, translationsConfig([{ language: LANG_A, translations: map }]));
		expect(created.statusCode).toBe(200);
		expect(created.body.data.translations).toEqual({ created: 3, updated: 0, deleted: 0 });

		const { docs } = await snapshotDocs(api);
		const stored = docFor(docs, LANG_A)!.translations;

		expect(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value).toBe('proto-value');
		expect(stored['']).toBe('blank-key-value');
		expect(stored['normal']).toBe('n');
	});

	test('round-trips a 255 code point astral key at the limit', async ({ api }) => {
		const key = String.fromCodePoint(0x1f600).repeat(255);

		const created = await apply(api, translationsConfig([{ language: LANG_A, translations: { [key]: 'ok' } }]));
		expect(created.statusCode).toBe(200);
		expect(created.body.data.translations).toEqual({ created: 1, updated: 0, deleted: 0 });

		const { docs } = await snapshotDocs(api);
		expect(docFor(docs, LANG_A)?.translations[key]).toBe('ok');
	});
});

describe('Config-as-Code translations catalogue enforcement', () => {
	test('refuses an authored language absent from the catalogue and stores nothing', async ({ api }) => {
		const refused = await apply(api, translationsConfig([{ language: 'made-up', translations: { a: '1' } }]));

		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('CONFIG_INVALID');
		expect(await rows(api, { language: 'made-up' })).toHaveLength(0);
	});

	test('fails the snapshot read on a stored non-catalogue language', async ({ api }) => {
		const db = api.database;
		await db(TABLE).insert({ id: randomUUID(), language: 'made-up', key: 'a', value: '1' });

		try {
			const res = await request(api.url).get('/config/snapshot').set('Authorization', auth());

			expect(res.statusCode).toBe(500);
			expect(errorCodes(res)).toContain('CONFIG_READ_FAILED');
			expect(await rows(api, { language: 'made-up' })).toHaveLength(1);
		} finally {
			await db(TABLE).where({ language: 'made-up' }).del();
		}
	});
});

describe('Config-as-Code translations validation', () => {
	test('refuses a duplicate language document before any mutation', async ({ api }) => {
		const duplicate = await apply(
			api,
			translationsConfig([
				{ language: LANG_A, translations: { a: '1' } },
				{ language: LANG_A, translations: { b: '2' } },
			])
		);

		expect(duplicate.statusCode).toBe(400);
		expect(errorCodes(duplicate)).toContain('CONFIG_IDENTITY_CONFLICT');
		expect(await rows(api)).toHaveLength(0);
	});

	test('refuses a non-string value and stores nothing', async ({ api }) => {
		const invalid = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { a: 5 as unknown as string } }])
		);

		expect(invalid.statusCode).toBe(400);
		expect(errorCodes(invalid)).toContain('CONFIG_INVALID');
		expect(await rows(api)).toHaveLength(0);
	});

	test('refuses a malformed Unicode value over HTTP and stores nothing', async ({ api }) => {
		const refused = await apply(
			api,
			translationsConfig([{ language: LANG_A, translations: { k: `v${String.fromCharCode(0xdc00)}` } }])
		);

		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('CONFIG_INVALID');
		expect(await rows(api, { language: LANG_A })).toHaveLength(0);
	});
});

describe('Config-as-Code translations manifest v1 rejection', () => {
	test('refuses translations at manifest version 1 and changes nothing', async ({ api }) => {
		const unsupported = await apply(api, {
			manifest: { version: 1, resources: ['translations'] },
			roles: [],
			permissions: [],
		});

		expect(unsupported.statusCode).toBe(400);
		expect(errorCodes(unsupported)).toContain('CONFIG_UNSUPPORTED_VERSION');

		const carriedKey = await apply(api, {
			manifest: { version: 1, resources: [] },
			roles: [],
			permissions: [],
			translations: [{ language: LANG_A, translations: { a: '1' } }],
		});

		expect(carriedKey.statusCode).toBe(400);
		expect(errorCodes(carriedKey)).toContain('CONFIG_INVALID');
		expect(await rows(api)).toHaveLength(0);
	});
});

describe('Config-as-Code translations local CLI', () => {
	async function writeConfigDir(root: string, doc: TranslationsDoc): Promise<void> {
		await fs.writeFile(path.join(root, 'cairncms-config.yaml'), dumpYaml({ version: 2, resources: ['translations'] }));
		await fs.mkdir(path.join(root, 'translations'), { recursive: true });
		await fs.writeFile(path.join(root, 'translations', `${doc.language}.yaml`), dumpYaml(doc));
	}

	function runCli(api: Api, args: string[], env: Record<string, string>) {
		return api.cli(args, { env, timeoutMs: CLI_TIMEOUT });
	}

	test('snapshots each language to its literal filename with a flat map', async ({ api }) => {
		await seed(api, { language: LANG_A, key: 'greeting', value: 'Hello' });
		await seed(api, { language: LANG_A, key: 'farewell', value: 'Goodbye' });

		const dir = await fs.mkdtemp(path.join(api.directory, 'cairncms-translations-cli-'));

		try {
			const snapshot = await runCli(api, ['config', 'snapshot', dir, '--yes'], {});

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

	test('applies a translations-scoped directory and preserves it on re-snapshot', async ({ api }) => {
		const dir = await fs.mkdtemp(path.join(api.directory, 'cairncms-translations-apply-'));

		try {
			await writeConfigDir(dir, { language: LANG_A, translations: { greeting: 'Hello', welcome: 'Welcome' } });

			const applied = await runCli(api, ['config', 'apply', dir, '--yes'], {});
			expect(applied.error).toBeUndefined();
			expect(applied.status).toBe(0);

			expect(await keysFor(api, LANG_A)).toEqual(['greeting', 'welcome']);

			const snapshot = await runCli(api, ['config', 'snapshot', dir, '--yes'], {});

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

describeForVendors(
	'Config-as-Code translations remote CLI',
	['postgres'],
	'Remote CLI transport behavior is validated against PostgreSQL.',
	() => {
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
				{ encoding: 'utf8', timeout: CLI_TIMEOUT }
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

			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => resolve(server));
			});
		}

		function runCli(api: Api, args: string[], env: Record<string, string>) {
			return api.cli(args, { env, timeoutMs: CLI_TIMEOUT });
		}

		async function withRemote(
			api: Api,
			run: (remote: { workDir: string; proxyUrl: string; trustedEnv: Record<string, string> }) => Promise<void>
		) {
			const workDir = await fs.mkdtemp(path.join(api.directory, 'remote-cli-'));
			let proxy: https.Server | undefined;

			try {
				const { certPath, keyPath } = generateCert(workDir);
				const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
				proxy = await startProxy(cert, key, api.url);
				const proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
				const trustedEnv = { CAIRNCMS_TOKEN: common.USER.ADMIN.TOKEN, NODE_EXTRA_CA_CERTS: certPath };
				await run({ workDir, proxyUrl, trustedEnv });
			} finally {
				proxy?.closeAllConnections();

				await new Promise<void>((resolve, reject) =>
					proxy ? proxy.close((error) => (error ? reject(error) : resolve())) : resolve()
				);

				await fs.rm(workDir, { recursive: true, force: true });
			}
		}

		test('snapshots a language file and applies an update over the wire', async ({ api }) => {
			await withRemote(api, async ({ workDir, proxyUrl, trustedEnv }) => {
				await seed(api, { language: LANG_A, key: 'greeting', value: 'Hello' });

				const fixture = path.join(workDir!, 'config');
				await fs.mkdir(fixture, { recursive: true });

				const snapshot = await runCli(api, ['config', 'snapshot', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
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

				const applied = await runCli(api, ['config', 'apply', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
				expect(applied.status).toBe(0);

				const stored = await rows(api, { language: LANG_A });
				expect(stored).toHaveLength(1);
				expect(stored[0]!.value).toBe('Hi');
			});
		}, 120000);
	}
);
