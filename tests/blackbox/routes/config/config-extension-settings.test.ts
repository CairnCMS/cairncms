import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
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
import { CreateCollection, DeleteCollection } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';

const TABLE = 'cairncms_extension_settings';
const SUBJECT = 'cairncms-extension-settings-fixture';
const SECRET_MASK = '**********';
const BILLING_REFERENCE = '{{CAIRNCMS_EXT_SETTINGS_FIXTURE_BILLING_KEY}}';
const COLLECTION = 'config_ext_settings_target';
const REMOTE_VENDOR = 'postgres';
const MIN_VERSION = '1.6.0';
const CLI_TIMEOUT = 25000;

const stem = `${SUBJECT}-${createHash('sha256').update(SUBJECT).digest('hex').slice(0, 8)}`;
const FIXTURE_FILE = `${stem}.yaml`;

const databases = new Map<string, Knex>();

function auth(): string {
	return `Bearer ${common.USER.ADMIN.TOKEN}`;
}

type Doc = { subject: string; global: Record<string, unknown>; collections: Record<string, Record<string, unknown>> };

function doc(global: Record<string, unknown> = {}, collections: Record<string, Record<string, unknown>> = {}): Doc {
	return { subject: SUBJECT, global, collections };
}

function extConfig(docs: Doc[]): unknown {
	return {
		manifest: { version: 2, resources: ['extension-settings'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': docs,
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

async function seed(vendor: string, body: { scope: string; scope_key: string; key: string; value: unknown }) {
	const res = await request(getUrl(vendor))
		.post('/extension-settings')
		.set('Authorization', auth())
		.send({ subject: SUBJECT, ...body });

	expect(res.status).toBe(200);
}

async function adminRows(
	vendor: string
): Promise<Array<{ scope: string; scope_key: string; key: string; value: unknown }>> {
	const res = await request(getUrl(vendor)).get(`/extension-settings?subject=${SUBJECT}`).set('Authorization', auth());
	expect(res.status).toBe(200);
	return res.body.data;
}

async function globalValue(vendor: string, key: string): Promise<unknown> {
	return (await adminRows(vendor)).find((row) => row.scope === 'global' && row.key === key)?.value;
}

async function fixtureDoc(vendor: string): Promise<{ snapshot: any; document: Doc | undefined }> {
	const res = await request(getUrl(vendor)).get('/config/snapshot').set('Authorization', auth());
	expect(res.statusCode).toBe(200);
	const docs = (res.body.data['extension-settings'] ?? []) as Doc[];
	return { snapshot: res.body.data, document: docs.find((entry) => entry.subject === SUBJECT) };
}

async function rawRows(vendor: string, extra: Record<string, unknown> = {}) {
	return databases.get(vendor)!(TABLE).where({ extension: SUBJECT, ...extra });
}

async function rawRow(vendor: string, extra: Record<string, unknown> = {}) {
	return databases.get(vendor)!(TABLE)
		.where({ extension: SUBJECT, ...extra })
		.first();
}

async function walkFiles(dir: string): Promise<string[]> {
	const out: string[] = [];

	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkFiles(full)));
		else out.push(full);
	}

	return out;
}

async function readTree(dir: string): Promise<string> {
	const files = await walkFiles(dir);
	const contents = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
	return contents.join('\n');
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
		databases.set(vendor, db);

		// The extension-service suite uses the same subject.
		await db(TABLE).where({ extension: SUBJECT }).del();
		await DeleteCollection(vendor, { collection: COLLECTION });
		await CreateCollection(vendor, { collection: COLLECTION });

		const check = await request(getUrl(vendor)).get(`/collections/${COLLECTION}`).set('Authorization', auth());
		expect(check.status).toBe(200);
	}
});

afterEach(async () => {
	const failures: string[] = [];

	for (const [vendor, db] of databases) {
		await attemptCleanup(failures, `${vendor} purge`, async () => {
			await db(TABLE).where({ extension: SUBJECT }).del();
		});
	}

	if (failures.length > 0) throw new Error(failures.join('; '));
});

afterAll(async () => {
	const failures: string[] = [];

	for (const [vendor, db] of databases) {
		await attemptCleanup(failures, `${vendor} purge`, async () => {
			await db(TABLE).where({ extension: SUBJECT }).del();
		});

		await attemptCleanup(failures, `${vendor} drop collection`, async () => {
			// The shared deletion helper does not check response status.
			await request(getUrl(vendor)).delete(`/collections/${COLLECTION}`).set('Authorization', auth()).expect(204);
		});

		await attemptCleanup(failures, `${vendor} destroy`, async () => {
			await db.destroy();
		});
	}

	if (failures.length > 0) throw new Error(failures.join('; '));
});

describe('Config-as-Code extension settings ordinary round-trip', () => {
	it.each(vendors)('%s creates, updates, and re-applies ordinary values as a no-op', async (vendor) => {
		const created = await apply(
			vendor,
			extConfig([
				doc({ base_url: 'https://a.example', theme: 'light' }, { [COLLECTION]: { preview_url: 'https://p/1' } }),
			])
		);

		expect(created.statusCode).toBe(200);
		expect(created.body.data['extension-settings']).toEqual({ created: 3, updated: 0, deleted: 0 });

		const first = await fixtureDoc(vendor);

		// Config-sourced references come from declarations, not stored rows.
		expect(first.document?.global).toEqual({
			base_url: 'https://a.example',
			theme: 'light',
			billing_key: BILLING_REFERENCE,
		});

		expect(first.document?.collections).toEqual({ [COLLECTION]: { preview_url: 'https://p/1' } });

		const updated = await apply(
			vendor,
			extConfig([
				doc({ base_url: 'https://b.example', theme: 'light' }, { [COLLECTION]: { preview_url: 'https://p/1' } }),
			])
		);

		expect(updated.statusCode).toBe(200);
		expect(updated.body.data['extension-settings']).toEqual({ created: 0, updated: 1, deleted: 0 });
		expect(await globalValue(vendor, 'base_url')).toBe('https://b.example');

		const reapply = await apply(
			vendor,
			extConfig([
				doc({ base_url: 'https://b.example', theme: 'light' }, { [COLLECTION]: { preview_url: 'https://p/1' } }),
			])
		);

		expect(reapply.statusCode).toBe(200);
		expect(reapply.body.data['extension-settings']).toEqual({ created: 0, updated: 0, deleted: 0 });
	});
});

describe('Config-as-Code extension settings inline secret', () => {
	it.each(vendors)('%s snapshots a secret as a marker, never plaintext, and stores an envelope', async (vendor) => {
		const plaintext = 'sk_live_snapshot_probe';
		await seed(vendor, { scope: 'global', scope_key: '', key: 'api_key', value: plaintext });

		const { snapshot, document } = await fixtureDoc(vendor);
		expect(document?.global['api_key']).toEqual({ $secret: 'preserve' });
		expect(JSON.stringify(snapshot)).not.toContain(plaintext);

		const stored = await rawRow(vendor, { key: 'api_key' });
		expect(JSON.parse(stored.value).kind).toBe('cairncms-secret-envelope');
		expect(stored.value).not.toContain(plaintext);
	});

	it.each(vendors)('%s preserves a stored secret as a no-op without changing the envelope', async (vendor) => {
		await seed(vendor, { scope: 'global', scope_key: '', key: 'api_key', value: 'sk_live_preserve_probe' });

		const before = await rawRow(vendor, { key: 'api_key' });

		const preserved = await apply(vendor, extConfig([doc({ api_key: { $secret: 'preserve' } })]));
		expect(preserved.statusCode).toBe(200);
		expect(preserved.body.data['extension-settings']).toEqual({ created: 0, updated: 0, deleted: 0 });

		const after = await rawRow(vendor, { key: 'api_key' });
		expect(after.value).toBe(before.value);
		expect(await globalValue(vendor, 'api_key')).toBe(SECRET_MASK);
	});

	it.each(vendors)('%s gates a secret deletion on --destructive and refuses before any mutation', async (vendor) => {
		const plaintext = 'sk_live_delete_probe';
		await seed(vendor, { scope: 'global', scope_key: '', key: 'base_url', value: 'https://a.example' });
		await seed(vendor, { scope: 'global', scope_key: '', key: 'api_key', value: plaintext });

		const envelopeBefore = (await rawRow(vendor, { key: 'api_key' })).value;

		const refused = await apply(vendor, extConfig([doc({ base_url: 'https://b.example' })]));
		expect(refused.statusCode).toBe(400);
		expect(errorCodes(refused)).toContain('DESTRUCTIVE_CHANGES_REQUIRED');
		expect(JSON.stringify(refused.body)).not.toContain(plaintext);

		expect(await globalValue(vendor, 'base_url')).toBe('https://a.example');
		expect((await rawRow(vendor, { key: 'api_key' })).value).toBe(envelopeBefore);

		const authorized = await apply(vendor, extConfig([doc({ base_url: 'https://b.example' })]), { destructive: true });
		expect(authorized.statusCode).toBe(200);
		expect(authorized.body.data['extension-settings']).toEqual({ created: 0, updated: 1, deleted: 1 });
		expect(JSON.stringify(authorized.body)).not.toContain(plaintext);

		expect(await globalValue(vendor, 'base_url')).toBe('https://b.example');
		expect(await rawRows(vendor, { key: 'api_key' })).toHaveLength(0);
	});

	it.each(vendors)('%s preserves an absent secret as a pure no-op that creates no row', async (vendor) => {
		const bootstrap = await apply(vendor, extConfig([doc({ api_key: { $secret: 'preserve' } })]));

		expect(bootstrap.statusCode).toBe(200);
		expect(bootstrap.body.data['extension-settings']).toEqual({ created: 0, updated: 0, deleted: 0 });
		expect(await rawRows(vendor, { key: 'api_key' })).toHaveLength(0);
	});
});

describe('Config-as-Code extension settings config-sourced reference', () => {
	it.each(vendors)('%s emits the exact reference, stores no row, and refuses any other value', async (vendor) => {
		const { snapshot, document } = await fixtureDoc(vendor);
		expect(document?.global['billing_key']).toBe(BILLING_REFERENCE);
		expect(JSON.stringify(snapshot)).not.toContain('billing-secret-from-config');

		const referenced = await apply(vendor, extConfig([doc({ billing_key: BILLING_REFERENCE })]));
		expect(referenced.statusCode).toBe(200);
		expect(referenced.body.data['extension-settings']).toEqual({ created: 0, updated: 0, deleted: 0 });
		expect(await rawRows(vendor, { key: 'billing_key' })).toHaveLength(0);

		const wrong = await apply(vendor, extConfig([doc({ billing_key: 'not-the-reference' })]));
		expect(wrong.statusCode).toBe(400);
		expect(errorCodes(wrong)).toContain('CONFIG_INVALID');
		expect(await rawRows(vendor, { key: 'billing_key' })).toHaveLength(0);
	});
});

describe('Config-as-Code extension settings subject-scoped ownership', () => {
	it.each(vendors)('%s leaves a subject untouched when no file names it', async (vendor) => {
		await seed(vendor, { scope: 'global', scope_key: '', key: 'base_url', value: 'https://keep.example' });

		const empty = await apply(vendor, extConfig([]));
		expect(empty.statusCode).toBe(200);
		expect(empty.body.data['extension-settings']).toEqual({ created: 0, updated: 0, deleted: 0 });
		expect(await globalValue(vendor, 'base_url')).toBe('https://keep.example');
	});

	it.each(vendors)('%s clears declared stored values on an empty document while inert rows survive', async (vendor) => {
		await seed(vendor, { scope: 'global', scope_key: '', key: 'base_url', value: 'https://a.example' });
		await seed(vendor, { scope: 'global', scope_key: '', key: 'api_key', value: 'sk_live_clear_probe' });

		// Seed directly because the API rejects undeclared keys.
		await databases.get(vendor)!(TABLE).insert({
			id: '00000000-0000-4000-8000-0000000000c4',
			extension: SUBJECT,
			scope: 'global',
			scope_key: '',
			key: 'legacy_undeclared',
			value: JSON.stringify('inert-value'),
		});

		const cleared = await apply(vendor, extConfig([doc({}, {})]), { destructive: true });
		expect(cleared.statusCode).toBe(200);
		expect(cleared.body.data['extension-settings']).toEqual({ created: 0, updated: 0, deleted: 2 });

		const rows = await rawRows(vendor);
		expect(rows).toHaveLength(1);
		expect(rows[0].key).toBe('legacy_undeclared');
		expect(rows[0].value).toBe(JSON.stringify('inert-value'));
	});

	it.each(vendors)('%s refuses an uninstalled subject and a duplicate subject', async (vendor) => {
		const absent = await apply(vendor, {
			manifest: { version: 2, resources: ['extension-settings'] },
			roles: [],
			permissions: [],
			folders: [],
			settings: [],
			'extension-settings': [{ subject: 'cairncms-extension-not-installed', global: {}, collections: {} }],
		});

		expect(absent.statusCode).toBe(400);
		expect(errorCodes(absent)).toContain('CONFIG_INVALID');

		const duplicate = await apply(
			vendor,
			extConfig([doc({ base_url: 'https://one' }), doc({ base_url: 'https://two' })])
		);

		expect(duplicate.statusCode).toBe(400);
		expect(errorCodes(duplicate)).toContain('CONFIG_IDENTITY_CONFLICT');
	});

	it.each(vendors)('%s refuses an unavailable subject and leaves its stored rows inert', async (vendor) => {
		const orphan = 'cairncms-extension-not-installed';
		const db = databases.get(vendor)!;
		await db(TABLE).where({ extension: orphan }).del();

		await db(TABLE).insert({
			id: '00000000-0000-4000-8000-0000000000d5',
			extension: orphan,
			scope: 'global',
			scope_key: '',
			key: 'leftover',
			value: JSON.stringify('inert'),
		});

		try {
			const refused = await apply(vendor, {
				manifest: { version: 2, resources: ['extension-settings'] },
				roles: [],
				permissions: [],
				folders: [],
				settings: [],
				'extension-settings': [{ subject: orphan, global: {}, collections: {} }],
			});

			expect(refused.statusCode).toBe(400);
			expect(errorCodes(refused)).toContain('CONFIG_INVALID');

			const rows = await db(TABLE).where({ extension: orphan });
			expect(rows).toHaveLength(1);
			expect(rows[0].value).toBe(JSON.stringify('inert'));
		} finally {
			await db(TABLE).where({ extension: orphan }).del();
		}
	});
});

describe('Config-as-Code extension settings discovery resilience', () => {
	it.each(vendors)(
		'%s keeps a rejected-manifest extension inert while a healthy snapshot and apply succeed',
		async (vendor) => {
			const db = databases.get(vendor)!;
			const rejected = 'cairncms-extension-cairn-badmanifest';
			await db(TABLE).where({ extension: rejected }).del();

			await db(TABLE).insert({
				id: '00000000-0000-4000-8000-0000000000e6',
				extension: rejected,
				scope: 'global',
				scope_key: '',
				key: 'leftover',
				value: JSON.stringify('inert'),
			});

			try {
				const diagnostics = await request(getUrl(vendor)).get('/extensions').set('Authorization', auth());
				expect(diagnostics.status).toBe(200);
				const byName = Object.fromEntries(diagnostics.body.data.map((row: any) => [row.name, row]));
				expect(byName[rejected]?.status).toBe('failed');

				const snapshot = await request(getUrl(vendor)).get('/config/snapshot').set('Authorization', auth());
				expect(snapshot.statusCode).toBe(200);
				const docs = (snapshot.body.data['extension-settings'] ?? []) as Doc[];
				expect(docs.some((entry) => entry.subject === SUBJECT)).toBe(true);
				expect(docs.some((entry) => entry.subject === rejected)).toBe(false);

				const applied = await apply(vendor, extConfig([doc({ base_url: 'https://healthy.example' })]));
				expect(applied.statusCode).toBe(200);
				expect(applied.body.data['extension-settings']).toEqual({ created: 1, updated: 0, deleted: 0 });

				const rows = await db(TABLE).where({ extension: rejected });
				expect(rows).toHaveLength(1);
				expect(rows[0].value).toBe(JSON.stringify('inert'));
			} finally {
				await db(TABLE).where({ extension: rejected }).del();
			}
		}
	);
});

describe('Config-as-Code extension settings validation', () => {
	it.each(vendors)('%s refuses invalid input, preserving the baseline and creating no rows', async (vendor) => {
		await seed(vendor, { scope: 'global', scope_key: '', key: 'base_url', value: 'https://valid.a' });
		await seed(vendor, { scope: 'global', scope_key: '', key: 'api_key', value: 'sk_live_validation_probe' });

		const envelopeBefore = (await rawRow(vendor, { key: 'api_key' })).value;
		const secretProbe = 'plain-secret-probe';

		const invalidDocs: Doc[] = [
			doc({ base_url: 'https://valid.b', not_declared: 'x' }),
			doc({ base_url: 42 }),
			doc({ base_url: 'https://valid.b', preview_url: 'https://x' }),
			doc({ base_url: 'https://valid.b', api_key: secretProbe }),
			doc({ base_url: 'https://valid.b' }, { config_ext_settings_absent: { preview_url: 'https://x' } }),
		];

		for (const invalid of invalidDocs) {
			const res = await apply(vendor, extConfig([invalid]));
			expect(res.statusCode).toBe(400);
			expect(errorCodes(res)).toContain('CONFIG_INVALID');
			expect(JSON.stringify(res.body)).not.toContain(secretProbe);
		}

		expect(await globalValue(vendor, 'base_url')).toBe('https://valid.a');
		expect((await rawRow(vendor, { key: 'api_key' })).value).toBe(envelopeBefore);
		expect(await rawRows(vendor, { key: 'not_declared' })).toHaveLength(0);
		expect((await rawRows(vendor)).map((row: any) => row.key).sort()).toEqual(['api_key', 'base_url']);
	});
});

describe('Config-as-Code extension settings manifest v1 rejection', () => {
	it.each(vendors)('%s refuses extension settings at manifest version 1 and changes nothing', async (vendor) => {
		const badManifest = await apply(vendor, {
			manifest: { version: 1, resources: ['extension-settings'] },
			roles: [],
			permissions: [],
		});

		expect(badManifest.statusCode).toBe(400);
		expect(errorCodes(badManifest)).toContain('CONFIG_UNSUPPORTED_VERSION');

		const carriedKey = await apply(vendor, {
			manifest: { version: 1, resources: [] },
			roles: [],
			permissions: [],
			'extension-settings': [doc({ base_url: 'https://x' })],
		});

		expect(carriedKey.statusCode).toBe(400);
		expect(errorCodes(carriedKey)).toContain('CONFIG_INVALID');
		expect(await rawRows(vendor)).toHaveLength(0);
	});
});

describe('Config-as-Code extension settings local CLI', () => {
	async function writeConfigDir(root: string, document: Doc): Promise<void> {
		await fs.writeFile(
			path.join(root, 'cairncms-config.yaml'),
			dumpYaml({ version: 2, resources: ['extension-settings'] })
		);

		await fs.mkdir(path.join(root, 'extension-settings'), { recursive: true });
		await fs.writeFile(path.join(root, 'extension-settings', FIXTURE_FILE), dumpYaml(document));
	}

	async function readFixtureFile(root: string): Promise<Doc> {
		return loadYaml(await fs.readFile(path.join(root, 'extension-settings', FIXTURE_FILE), 'utf8')) as Doc;
	}

	function runCli(args: string[], env: NodeJS.ProcessEnv) {
		return spawnSync('node', ['--no-node-snapshot', paths.cli, ...args], {
			cwd: paths.cwd,
			env,
			encoding: 'utf8',
			timeout: CLI_TIMEOUT,
		});
	}

	it.each(vendors)('%s snapshots the derived filename with marker and reference, never plaintext', async (vendor) => {
		const plaintext = 'sk_live_cli_probe';
		await seed(vendor, { scope: 'global', scope_key: '', key: 'base_url', value: 'https://cli.example' });
		await seed(vendor, { scope: 'global', scope_key: '', key: 'api_key', value: plaintext });

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-ext-cli-'));

		try {
			const snapshot = runCli(['config', 'snapshot', dir, '--yes'], {
				...config.envs[vendor as keyof typeof config.envs],
			});

			expect(snapshot.error).toBeUndefined();
			expect(snapshot.status).toBe(0);

			const written = await readFixtureFile(dir);
			expect(written.subject).toBe(SUBJECT);
			expect(written.global['base_url']).toBe('https://cli.example');
			expect(written.global['api_key']).toEqual({ $secret: 'preserve' });
			expect(written.global['billing_key']).toBe(BILLING_REFERENCE);

			expect(await readTree(dir)).not.toContain(plaintext);
			expect(snapshot.stdout ?? '').not.toContain(plaintext);
			expect(snapshot.stderr ?? '').not.toContain(plaintext);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.each(vendors)('%s resolves nested placeholders on apply and preserves them on re-snapshot', async (vendor) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-ext-placeholder-'));
		const globalPlaceholder = '{{CAIRNCMS_CONFIG_EXT_BASEURL}}';
		const collectionPlaceholder = '{{CAIRNCMS_CONFIG_EXT_PREVIEW}}';

		try {
			await writeConfigDir(
				dir,
				doc({ base_url: globalPlaceholder }, { [COLLECTION]: { preview_url: collectionPlaceholder } })
			);

			const resolvedEnv = {
				...config.envs[vendor as keyof typeof config.envs],
				CAIRNCMS_CONFIG_EXT_BASEURL: 'https://resolved.global',
				CAIRNCMS_CONFIG_EXT_PREVIEW: 'https://resolved.collection',
			};

			const applied = runCli(['config', 'apply', dir, '--yes'], resolvedEnv);
			expect(applied.error).toBeUndefined();
			expect(applied.status).toBe(0);

			const stored = await fixtureDoc(vendor);
			expect(stored.document?.global['base_url']).toBe('https://resolved.global');
			expect(stored.document?.collections[COLLECTION]?.['preview_url']).toBe('https://resolved.collection');

			const unsetEnv = { ...config.envs[vendor as keyof typeof config.envs] };
			delete unsetEnv['CAIRNCMS_CONFIG_EXT_BASEURL'];
			delete unsetEnv['CAIRNCMS_CONFIG_EXT_PREVIEW'];

			const snapshot = runCli(['config', 'snapshot', dir, '--yes'], unsetEnv);
			expect(snapshot.error).toBeUndefined();
			expect(snapshot.status).toBe(0);

			const written = await readFixtureFile(dir);
			expect(written.global['base_url']).toBe(globalPlaceholder);
			expect(written.collections[COLLECTION]?.['preview_url']).toBe(collectionPlaceholder);
			// The seeded file lacks this key, so a no-op snapshot cannot satisfy the assertion.
			expect(written.global['billing_key']).toBe(BILLING_REFERENCE);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('Config-as-Code extension settings remote CLI', () => {
	const runsRemote = vendors.includes(REMOTE_VENDOR);
	let workDir: string | undefined;
	let isolatedExtensions: string | undefined;
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
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-ext-remote-'));
		// Unsetting EXTENSIONS_PATH would use ./extensions rather than guarantee an empty catalogue.
		isolatedExtensions = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-ext-empty-'));
		const { certPath, keyPath } = generateCert(workDir);
		const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
		proxy = await startProxy(cert, key, getUrl(REMOTE_VENDOR));
		proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

		trustedEnv = {
			...config.envs[REMOTE_VENDOR],
			EXTENSIONS_PATH: isolatedExtensions,
			CAIRNCMS_TOKEN: common.USER.ADMIN.TOKEN,
			NODE_EXTRA_CA_CERTS: certPath,
		};
	});

	afterAll(async () => {
		if (!runsRemote) return;
		await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
		if (workDir) await fs.rm(workDir, { recursive: true, force: true });
		if (isolatedExtensions) await fs.rm(isolatedExtensions, { recursive: true, force: true });
	});

	(runsRemote ? it : it.skip)(
		'snapshots both secret forms safely and applies an ordinary update over the wire',
		async () => {
			const plaintext = 'sk_live_remote_probe';
			await seed(REMOTE_VENDOR, { scope: 'global', scope_key: '', key: 'base_url', value: 'https://remote.a' });
			await seed(REMOTE_VENDOR, { scope: 'global', scope_key: '', key: 'api_key', value: plaintext });

			const fixture = path.join(workDir!, 'config');
			await fs.mkdir(fixture, { recursive: true });

			const snapshot = await runCli(['config', 'snapshot', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
			expect(snapshot.status).toBe(0);

			const written = loadYaml(
				await fs.readFile(path.join(fixture, 'extension-settings', FIXTURE_FILE), 'utf8')
			) as Doc;

			expect(written.global['api_key']).toEqual({ $secret: 'preserve' });
			expect(written.global['billing_key']).toBe(BILLING_REFERENCE);

			expect(await readTree(fixture)).not.toContain(plaintext);
			expect(snapshot.stdout).not.toContain(plaintext);
			expect(snapshot.stderr).not.toContain(plaintext);

			await fs.writeFile(
				path.join(fixture, 'cairncms-config.yaml'),
				dumpYaml({ version: 2, resources: ['extension-settings'] })
			);

			await fs.writeFile(
				path.join(fixture, 'extension-settings', FIXTURE_FILE),
				dumpYaml(doc({ base_url: 'https://remote.b', api_key: { $secret: 'preserve' } }))
			);

			const applied = await runCli(['config', 'apply', fixture, '--url', proxyUrl, '--yes'], trustedEnv);
			expect(applied.status).toBe(0);
			expect(await globalValue(REMOTE_VENDOR, 'base_url')).toBe('https://remote.b');
		},
		120000
	);
});
