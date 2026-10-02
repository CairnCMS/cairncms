import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import { CreateCollection } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const TABLE = 'cairncms_extension_settings';
const SUBJECT = 'cairncms-extension-settings-fixture';
const BAD_SUBJECT = 'bad-subject';
const ORPHAN_SUBJECT = 'cairncms-extension-uninstalled';
const PREVIEW_COLLECTION = 'settings_preview_target';
const TOKEN = () => USER.ADMIN!.TOKEN;
const SECRET_MASK = '**********';

const APP_COLLECTION = 'settings_app_target';
const ECHO_SUBJECT = 'cairncms-extension-confined-echo-endpoint';

const test = createIdentityTest({
	extensions: [SUBJECT, 'cairncms-extension-bad-subject', ECHO_SUBJECT],
	extensionNames: { 'cairncms-extension-bad-subject': BAD_SUBJECT },
	env: {
		CAIRNCMS_EXT_SETTINGS_FIXTURE_BILLING_KEY: 'billing-secret-from-config',
		CAIRNCMS_EXT_CONFINED_ECHO_ENDPOINT_BILLING_KEY: 'confined-billing-secret-value',
	},
}).extend<{ schemaState: Prerequisite<void>; schema: void; cleanSettings: void }>({
	schemaState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					await CreateCollection(api, { collection: PREVIEW_COLLECTION });
					await CreateCollection(api, { collection: APP_COLLECTION });
					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	schema: async ({ api, identities, schemaState, task, skip }, use) => {
		void api;
		void identities;
		requirePrerequisite(schemaState, 'settings target collections', { task, skip });
		await use();
	},
	cleanSettings: [
		async ({ api, schema }, use) => {
			void schema;
			await api.database(TABLE).whereIn('extension', [SUBJECT, BAD_SUBJECT, ORPHAN_SUBJECT, ECHO_SUBJECT]).delete();
			await use();
		},
		{ auto: true },
	],
});

async function DeleteCollection(api: Api, { collection }: { collection: string }, existing = true) {
	const response = await request(api.url)
		.delete('/collections/' + collection)
		.auth(api.adminToken, { type: 'bearer' });

	expect(existing ? [204] : [204, 403, 404]).toContain(response.status);
	return response.body;
}

describe('the extension settings service over /extension-settings', () => {
	test('round-trips a value, encrypts a secret at rest, masks its read, and purges', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;
		const db = api.database;
		const plaintext = 'sk_live_blackbox_secret';

		const set = await request(url).post('/extension-settings').set('Authorization', auth).send({
			subject: SUBJECT,
			scope: 'global',
			scope_key: '',
			key: 'base_url',
			value: 'https://preview.example.com',
		});

		expect(set.status).toBe(200);

		const setSecret = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'api_key', value: plaintext });

		expect(setSecret.status).toBe(200);

		const read = await request(url).get(`/extension-settings?subject=${SUBJECT}`).set('Authorization', auth);
		expect(read.status).toBe(200);

		const byKey = Object.fromEntries(read.body.data.map((row: any) => [row.key, row.value]));
		expect(byKey.base_url).toBe('https://preview.example.com');
		expect(byKey.api_key).toBe(SECRET_MASK);
		expect(JSON.stringify(read.body)).not.toContain(plaintext);

		const stored = await db(TABLE).where({ extension: SUBJECT, key: 'api_key' }).first();
		const storedValue = JSON.parse(stored.value);
		expect(storedValue.kind).toBe('cairncms-secret-envelope');
		expect(stored.value).not.toContain(plaintext);

		const removed = await request(url)
			.delete('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: SUBJECT });

		expect(removed.status).toBe(200);
		expect(removed.body.data.removed).toBeGreaterThanOrEqual(2);

		const afterPurge = await request(url).get(`/extension-settings?subject=${SUBJECT}`).set('Authorization', auth);
		expect(afterPurge.body.data).toEqual([]);
	});

	test('round-trips a collection-scoped value against a real collection', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;

		const set = await request(url).post('/extension-settings').set('Authorization', auth).send({
			subject: SUBJECT,
			scope: 'collection',
			scope_key: PREVIEW_COLLECTION,
			key: 'preview_url',
			value: 'https://preview.example.com/article',
		});

		expect(set.status).toBe(200);

		const read = await request(url)
			.get(`/extension-settings?subject=${SUBJECT}&scope=collection&scope_key=${PREVIEW_COLLECTION}`)
			.set('Authorization', auth);

		expect(read.status).toBe(200);

		expect(read.body.data).toEqual([
			{
				scope: 'collection',
				scope_key: PREVIEW_COLLECTION,
				key: 'preview_url',
				value: 'https://preview.example.com/article',
			},
		]);
	});

	test('refuses every invalid write with a 400', async ({ api }) => {
		const url = api.url;

		const post = (body: any) =>
			request(url).post('/extension-settings').set('Authorization', `Bearer ${TOKEN()}`).send(body);

		expect((await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'nope', value: 'x' })).status).toBe(
			400
		);

		expect(
			(await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'api_key', value: { source: 'config' } }))
				.status
		).toBe(400);

		expect(
			(await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'api_key', value: SECRET_MASK })).status
		).toBe(400);

		expect(
			(await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'billing_key', value: 'anything' })).status
		).toBe(400);

		expect(
			(await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'preview_url', value: 'x' })).status
		).toBe(400);

		expect(
			(await post({ subject: SUBJECT, scope: 'collection', scope_key: 'ghosts', key: 'preview_url', value: 'x' }))
				.status
		).toBe(400);

		expect((await post({ scope: 'global', scope_key: '', key: 'base_url', value: 'x' })).status).toBe(400);
	});

	test('clears exactly one value and refuses a partial delete body without purging', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;
		const post = (body: any) => request(url).post('/extension-settings').set('Authorization', auth).send(body);
		const del = (body: any) => request(url).delete('/extension-settings').set('Authorization', auth).send(body);

		const readGlobalKeys = async () => {
			const read = await request(url)
				.get(`/extension-settings?subject=${SUBJECT}&scope=global&scope_key=`)
				.set('Authorization', auth);

			expect(read.status).toBe(200);
			return Object.fromEntries(read.body.data.map((row: any) => [row.key, row.value]));
		};

		expect(
			(await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://a' })).status
		).toBe(200);

		expect((await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'theme', value: 'dark' })).status).toBe(
			200
		);

		const partial = await del({ subject: SUBJECT, key: 'base_url' });
		expect(partial.status).toBe(400);

		const mistyped = await del({ subject: SUBJECT, scopeKey: 'articles' });
		expect(mistyped.status).toBe(400);

		const extraneous = await del({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', extra: true });
		expect(extraneous.status).toBe(400);

		const arrayBody = await del([{ subject: SUBJECT }]);
		expect(arrayBody.status).toBe(400);

		const rawProtoJson = `{"subject":"${SUBJECT}","__proto__":{"scope":"global"}}`;
		expect(Object.keys(JSON.parse(rawProtoJson))).toContain('__proto__');

		const protoBody = await request(url)
			.delete('/extension-settings')
			.set('Authorization', auth)
			.set('Content-Type', 'application/json')
			.send(rawProtoJson);

		expect(protoBody.status).toBe(400);

		const afterRefusals = await readGlobalKeys();
		expect(afterRefusals['base_url']).toBe('https://a');
		expect(afterRefusals['theme']).toBe('dark');

		const cleared = await del({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url' });
		expect(cleared.status).toBe(200);
		expect(cleared.body.data.removed).toBe(1);

		const afterClear = await readGlobalKeys();
		expect(afterClear['base_url']).toBeUndefined();
		expect(afterClear['theme']).toBe('dark');

		await del({ subject: SUBJECT });
	});

	test('refuses an ineligible or absent subject while the extension still loads', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;

		const diagnostics = await request(url).get('/extensions').set('Authorization', auth);
		const byName = Object.fromEntries(diagnostics.body.data.map((row: any) => [row.name, row]));
		expect(byName[BAD_SUBJECT]?.status).toBe('loaded');

		const ineligible = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: BAD_SUBJECT, scope: 'global', scope_key: '', key: 'some_key', value: 'x' });

		expect(ineligible.status).toBe(403);

		const absent = await request(url).post('/extension-settings').set('Authorization', auth).send({
			subject: 'cairncms-extension-not-installed',
			scope: 'global',
			scope_key: '',
			key: 'base_url',
			value: 'x',
		});

		expect(absent.status).toBe(403);
	});

	test('reads and purges orphaned rows for an uninstalled subject', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;
		const db = api.database;

		await db(TABLE).where({ extension: ORPHAN_SUBJECT }).del();

		await db(TABLE).insert({
			id: '00000000-0000-4000-8000-000000000001',
			extension: ORPHAN_SUBJECT,
			scope: 'global',
			scope_key: '',
			key: 'leftover',
			value: JSON.stringify('orphan-value'),
		});

		const read = await request(url).get(`/extension-settings?subject=${ORPHAN_SUBJECT}`).set('Authorization', auth);
		expect(read.status).toBe(200);
		expect(read.body.data).toEqual([{ scope: 'global', scope_key: '', key: 'leftover', value: 'orphan-value' }]);

		const removed = await request(url)
			.delete('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: ORPHAN_SUBJECT });

		expect(removed.status).toBe(200);
		expect(removed.body.data.removed).toBe(1);

		const after = await request(url).get(`/extension-settings?subject=${ORPHAN_SUBJECT}`).set('Authorization', auth);
		expect(after.body.data).toEqual([]);
	});

	test('forbids a request without administrator access', async ({ api }) => {
		const url = api.url;
		const res = await request(url).get(`/extension-settings?subject=${SUBJECT}`);
		expect([401, 403]).toContain(res.status);
	});

	test('lists the settings owners with declarations and nothing infrastructure-facing', async ({ api }) => {
		const url = api.url;

		const anonymous = await request(url).get('/extension-settings/owners');
		expect([401, 403]).toContain(anonymous.status);

		const owners = await request(url).get('/extension-settings/owners').set('Authorization', `Bearer ${TOKEN()}`);
		expect(owners.status).toBe(200);

		const bySubject = Object.fromEntries(owners.body.data.map((owner: any) => [owner.displaySubject, owner]));

		expect(bySubject[SUBJECT]).toMatchObject({
			subject: SUBJECT,
			status: 'available',
			declaration: {
				api_key: { type: 'string', scope: 'global', secret: { source: 'inline' } },
				billing_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
			},
		});

		expect(bySubject[BAD_SUBJECT]?.status).toBe('unavailable');
		expect(bySubject[BAD_SUBJECT] && 'subject' in bySubject[BAD_SUBJECT]).toBe(false);
		expect(bySubject[BAD_SUBJECT] && 'declaration' in bySubject[BAD_SUBJECT]).toBe(false);

		expect(JSON.stringify(owners.body)).not.toContain('CAIRNCMS_EXT_');
	});

	test('deleting a collection purges its collection-scoped settings and leaves global ones', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;
		const db = api.database;
		const collection = 'settings_cascade_target';

		await db(TABLE).where({ extension: SUBJECT }).del();
		await DeleteCollection(api, { collection }, false);
		await CreateCollection(api, { collection });

		await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: SUBJECT, scope: 'collection', scope_key: collection, key: 'preview_url', value: 'https://x' });

		await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://g' });

		await DeleteCollection(api, { collection });

		const read = await request(url).get(`/extension-settings?subject=${SUBJECT}`).set('Authorization', auth);
		const rows: any[] = read.body.data;
		expect(rows.some((row) => row.scope_key === collection)).toBe(false);
		expect(rows.some((row) => row.scope === 'global' && row.key === 'base_url')).toBe(true);

		await db(TABLE).where({ extension: SUBJECT }).del();
	});

	test('deleting a meta-only collection purges its collection-scoped settings', async ({ api }) => {
		const url = api.url;
		const auth = `Bearer ${TOKEN()}`;
		const db = api.database;
		const folder = 'settings_meta_folder';

		await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: folder }).del();
		await DeleteCollection(api, { collection: folder }, false);

		const created = await request(url)
			.post('/collections')
			.set('Authorization', auth)
			.send({ collection: folder, schema: null, meta: {} });

		expect(created.status).toBe(200);

		await db(TABLE).insert({
			id: '00000000-0000-4000-8000-000000000010',
			extension: SUBJECT,
			scope: 'collection',
			scope_key: folder,
			key: 'preview_url',
			value: JSON.stringify('https://x'),
		});

		await DeleteCollection(api, { collection: folder });

		const remaining = await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: folder });
		expect(remaining).toHaveLength(0);
	});

	test('the collection-scoped purge rolls back with its transaction', async ({ api }) => {
		const db = api.database;
		const collection = 'settings_rollback_target';

		await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: collection }).del();

		await db(TABLE).insert({
			id: '00000000-0000-4000-8000-000000000011',
			extension: SUBJECT,
			scope: 'collection',
			scope_key: collection,
			key: 'preview_url',
			value: JSON.stringify('https://x'),
		});

		await db
			.transaction(async (trx) => {
				await trx(TABLE).where({ scope: 'collection', scope_key: collection }).delete();
				throw new Error('force rollback');
			})
			.catch(() => undefined);

		const remaining = await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: collection });
		expect(remaining).toHaveLength(1);

		await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: collection }).del();
	});
});

describe('the app-side settings read over /extension-settings/app', () => {
	const adminAuth = `Bearer ${USER.ADMIN!.TOKEN}`;

	async function seed(api: Api) {
		const url = api.url;
		const post = (body: any) => request(url).post('/extension-settings').set('Authorization', adminAuth).send(body);

		const writes = [
			{ subject: SUBJECT, scope: 'global', scope_key: '', key: 'theme', value: 'dark' },
			{ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://internal' },
			{ subject: SUBJECT, scope: 'global', scope_key: '', key: 'api_key', value: 'sk_live_app_secret' },
			{
				subject: SUBJECT,
				scope: 'collection',
				scope_key: APP_COLLECTION,
				key: 'preview_url',
				value: 'https://preview',
			},
		];

		for (const body of writes) {
			const res = await post(body);
			expect(res.status).toBe(200);
		}
	}

	const appTest = test.extend<{ appSettings: void }>({
		appSettings: [
			async ({ api, cleanSettings }, use) => {
				void cleanSettings;
				await seed(api);
				await use();
			},
			{ auto: true },
		],
	});

	appTest(
		'returns app-readable values, omitting non-opted-in and secret keys and any secret material',
		async ({ api }) => {
			const read = await request(api.url)
				.get(`/extension-settings/app?subject=${SUBJECT}&collection=${APP_COLLECTION}`)
				.set('Authorization', adminAuth);

			expect(read.status).toBe(200);
			expect(read.body.data).toEqual({ theme: 'dark', preview_url: 'https://preview' });

			const serialized = JSON.stringify(read.body.data);
			expect(serialized).not.toContain('api_key');
			expect(serialized).not.toContain('sk_live_app_secret');
			expect(serialized).not.toContain('base_url');
		}
	);

	appTest('refuses a non-app-access caller and an unauthenticated request', async ({ api }) => {
		const url = api.url;

		const apiOnly = await request(url)
			.get(`/extension-settings/app?subject=${SUBJECT}`)
			.set('Authorization', `Bearer ${USER.API_ONLY!.TOKEN}`);

		expect(apiOnly.status).toBe(403);

		const anon = await request(url).get(`/extension-settings/app?subject=${SUBJECT}`);
		expect(anon.status).toBe(401);
	});

	appTest('returns an empty object for an absent subject', async ({ api }) => {
		const read = await request(api.url)
			.get('/extension-settings/app?subject=cairncms-extension-not-installed')
			.set('Authorization', adminAuth);

		expect(read.status).toBe(200);
		expect(read.body.data).toEqual({});
	});

	appTest('rejects a missing or non-string parameter with a 400', async ({ api }) => {
		const url = api.url;

		const noSubject = await request(url).get('/extension-settings/app').set('Authorization', adminAuth);
		expect(noSubject.status).toBe(400);

		const arrayCollection = await request(url)
			.get(`/extension-settings/app?subject=${SUBJECT}&collection=a&collection=b`)
			.set('Authorization', adminAuth);

		expect(arrayCollection.status).toBe(400);
	});

	appTest('denies a non-admin the collection value without read permission', async ({ api }) => {
		const read = await request(api.url)
			.get(`/extension-settings/app?subject=${SUBJECT}&collection=${APP_COLLECTION}`)
			.set('Authorization', `Bearer ${USER.APP_ACCESS!.TOKEN}`);

		expect(read.status).toBe(200);
		expect(read.body.data).toEqual({ theme: 'dark' });
	});

	appTest('returns the collection value to a non-admin granted read permission', async ({ api }) => {
		const url = api.url;
		const appAuth = `Bearer ${USER.APP_ACCESS!.TOKEN}`;

		const me = await request(url).get('/users/me?fields=role').set('Authorization', appAuth);
		const role = me.body.data.role;

		const created = await request(url)
			.post('/permissions')
			.set('Authorization', adminAuth)
			.send({ role, collection: APP_COLLECTION, action: 'read', fields: ['*'] });

		expect(created.status).toBe(200);

		const permissionId = created.body.data.id;

		try {
			const read = await request(url)
				.get(`/extension-settings/app?subject=${SUBJECT}&collection=${APP_COLLECTION}`)
				.set('Authorization', appAuth);

			expect(read.status).toBe(200);
			expect(read.body.data).toEqual({ theme: 'dark', preview_url: 'https://preview' });
		} finally {
			await request(url).delete(`/permissions/${permissionId}`).set('Authorization', adminAuth);
		}
	});
});

describe('confined delivery of declared secrets', () => {
	const CONFINED_PLAINTEXT = 'sk_live_confined_blackbox_secret';
	const CONFIG_PLAINTEXT = 'confined-billing-secret-value';
	const adminAuth = `Bearer ${USER.ADMIN!.TOKEN}`;

	const echoTest = test.extend<{ echoSettings: void }>({
		echoSettings: [
			async ({ api, cleanSettings }, use) => {
				void cleanSettings;

				for (const [key, value] of [
					['site_label', 'Cairn Blackbox'],
					['api_key', CONFINED_PLAINTEXT],
				]) {
					await setupRequest(api.url)
						.post('/extension-settings')
						.set('Authorization', adminAuth)
						.send({ subject: ECHO_SUBJECT, scope: 'global', scope_key: '', key, value })
						.expect(200);
				}

				await use();
			},
			{ auto: true },
		],
	});

	echoTest('the confined guest reads a value and receives each secret only as a reference', async ({ api }) => {
		const response = await request(api.url).get(`/${ECHO_SUBJECT}/settings`);

		expect(response.status).toBe(200);
		expect(response.body.label).toBe('Cairn Blackbox');
		expect(response.body.apiKey.kind).toBe('secret-reference');
		expect(typeof response.body.apiKey.ref).toBe('string');
		expect(response.body.billingKey.kind).toBe('secret-reference');
		expect(response.body.undeclared).toBeNull();

		const serialized = JSON.stringify(response.body);
		expect(serialized).not.toContain(CONFINED_PLAINTEXT);
		expect(serialized).not.toContain(CONFIG_PLAINTEXT);
	});

	echoTest('the admin read of the confined subject masks the secret and skips config keys', async ({ api }) => {
		const read = await request(api.url)
			.get(`/extension-settings?subject=${ECHO_SUBJECT}`)
			.set('Authorization', adminAuth);

		expect(read.status).toBe(200);

		const byKey = Object.fromEntries(read.body.data.map((row: any) => [row.key, row.value]));
		expect(byKey.site_label).toBe('Cairn Blackbox');
		expect(byKey.api_key).toBe(SECRET_MASK);
		expect(byKey.billing_key).toBeUndefined();
		expect(JSON.stringify(read.body)).not.toContain(CONFINED_PLAINTEXT);
	});
});
