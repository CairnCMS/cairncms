import config, { getUrl } from '@common/config';
import { CreateCollection, DeleteCollection } from '@common/functions';
import * as common from '@common/index';
import vendors from '@common/get-dbs-to-test';
import knex, { type Knex } from 'knex';
import request from 'supertest';

const TABLE = 'cairncms_extension_settings';
const SUBJECT = 'cairncms-extension-settings-fixture';
const BAD_SUBJECT = 'bad-subject';
const ORPHAN_SUBJECT = 'cairncms-extension-uninstalled';
const PREVIEW_COLLECTION = 'settings_preview_target';
const TOKEN = () => common.USER.ADMIN.TOKEN;
const SECRET_MASK = '**********';

describe('the extension settings service over /extension-settings', () => {
	const databases = new Map<string, Knex>();

	beforeAll(async () => {
		for (const vendor of vendors) {
			databases.set(vendor, knex(config.knexConfig[vendor]!));
			await CreateCollection(vendor, { collection: PREVIEW_COLLECTION });
		}
	});

	afterAll(async () => {
		for (const [vendor, db] of databases) {
			await db(TABLE).whereIn('extension', [SUBJECT, BAD_SUBJECT, ORPHAN_SUBJECT]).del();
			await DeleteCollection(vendor, { collection: PREVIEW_COLLECTION });
			await db.destroy();
		}
	});

	it.each(vendors)('%s: round-trips a value, encrypts a secret at rest, masks its read, and purges', async (vendor) => {
		const url = getUrl(vendor);
		const auth = `Bearer ${TOKEN()}`;
		const db = databases.get(vendor)!;
		const plaintext = 'sk_live_blackbox_secret';

		const set = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://preview.example.com' });

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

	it.each(vendors)('%s: round-trips a collection-scoped value against a real collection', async (vendor) => {
		const url = getUrl(vendor);
		const auth = `Bearer ${TOKEN()}`;

		const set = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({
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

	it.each(vendors)('%s: refuses every invalid write with a 400', async (vendor) => {
		const url = getUrl(vendor);
		const post = (body: any) =>
			request(url).post('/extension-settings').set('Authorization', `Bearer ${TOKEN()}`).send(body);

		expect((await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'nope', value: 'x' })).status).toBe(400);

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

	it.each(vendors)('%s: refuses an ineligible or absent subject while the extension still loads', async (vendor) => {
		const url = getUrl(vendor);
		const auth = `Bearer ${TOKEN()}`;

		const diagnostics = await request(url).get('/extensions').set('Authorization', auth);
		const byName = Object.fromEntries(diagnostics.body.data.map((row: any) => [row.name, row]));
		expect(byName[BAD_SUBJECT]?.status).toBe('loaded');

		const ineligible = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: BAD_SUBJECT, scope: 'global', scope_key: '', key: 'some_key', value: 'x' });

		expect(ineligible.status).toBe(403);

		const absent = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: 'cairncms-extension-not-installed', scope: 'global', scope_key: '', key: 'base_url', value: 'x' });

		expect(absent.status).toBe(403);
	});

	it.each(vendors)('%s: reads and purges orphaned rows for an uninstalled subject', async (vendor) => {
		const url = getUrl(vendor);
		const auth = `Bearer ${TOKEN()}`;
		const db = databases.get(vendor)!;

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

	it.each(vendors)('%s: forbids a request without administrator access', async (vendor) => {
		const url = getUrl(vendor);
		const res = await request(url).get(`/extension-settings?subject=${SUBJECT}`);
		expect([401, 403]).toContain(res.status);
	});

	it.each(vendors)('%s: lists the settings owners with declarations and nothing infrastructure-facing', async (vendor) => {
		const url = getUrl(vendor);

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

	it.each(vendors)(
		'%s: deleting a collection purges its collection-scoped settings and leaves global ones',
		async (vendor) => {
			const url = getUrl(vendor);
			const auth = `Bearer ${TOKEN()}`;
			const db = databases.get(vendor)!;
			const collection = 'settings_cascade_target';

			await db(TABLE).where({ extension: SUBJECT }).del();
			await DeleteCollection(vendor, { collection });
			await CreateCollection(vendor, { collection });

			await request(url)
				.post('/extension-settings')
				.set('Authorization', auth)
				.send({ subject: SUBJECT, scope: 'collection', scope_key: collection, key: 'preview_url', value: 'https://x' });

			await request(url)
				.post('/extension-settings')
				.set('Authorization', auth)
				.send({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://g' });

			await DeleteCollection(vendor, { collection });

			const read = await request(url).get(`/extension-settings?subject=${SUBJECT}`).set('Authorization', auth);
			const rows: any[] = read.body.data;
			expect(rows.some((row) => row.scope_key === collection)).toBe(false);
			expect(rows.some((row) => row.scope === 'global' && row.key === 'base_url')).toBe(true);

			await db(TABLE).where({ extension: SUBJECT }).del();
		}
	);

	it.each(vendors)('%s: deleting a meta-only collection purges its collection-scoped settings', async (vendor) => {
		const url = getUrl(vendor);
		const auth = `Bearer ${TOKEN()}`;
		const db = databases.get(vendor)!;
		const folder = 'settings_meta_folder';

		await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: folder }).del();
		await DeleteCollection(vendor, { collection: folder });

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

		await DeleteCollection(vendor, { collection: folder });

		const remaining = await db(TABLE).where({ extension: SUBJECT, scope: 'collection', scope_key: folder });
		expect(remaining).toHaveLength(0);
	});

	it.each(vendors)('%s: the collection-scoped purge rolls back with its transaction', async (vendor) => {
		const db = databases.get(vendor)!;
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
	const databases = new Map<string, Knex>();
	const APP_COLLECTION = 'settings_app_target';
	const adminAuth = `Bearer ${common.USER.ADMIN.TOKEN}`;

	async function seed(vendor: string) {
		const url = getUrl(vendor);
		const post = (body: any) => request(url).post('/extension-settings').set('Authorization', adminAuth).send(body);

		const writes = [
			{ subject: SUBJECT, scope: 'global', scope_key: '', key: 'theme', value: 'dark' },
			{ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://internal' },
			{ subject: SUBJECT, scope: 'global', scope_key: '', key: 'api_key', value: 'sk_live_app_secret' },
			{ subject: SUBJECT, scope: 'collection', scope_key: APP_COLLECTION, key: 'preview_url', value: 'https://preview' },
		];

		for (const body of writes) {
			const res = await post(body);
			expect(res.status).toBe(200);
		}
	}

	beforeAll(async () => {
		for (const vendor of vendors) {
			databases.set(vendor, knex(config.knexConfig[vendor]!));
			await CreateCollection(vendor, { collection: APP_COLLECTION });
			await seed(vendor);
		}
	});

	afterAll(async () => {
		for (const [vendor, db] of databases) {
			await db('directus_permissions').where({ collection: APP_COLLECTION }).del();
			await db(TABLE).where({ extension: SUBJECT }).del();
			await DeleteCollection(vendor, { collection: APP_COLLECTION });
			await db.destroy();
		}
	});

	it.each(vendors)(
		'%s: returns app-readable values, omitting non-opted-in and secret keys and any secret material',
		async (vendor) => {
			const read = await request(getUrl(vendor))
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

	it.each(vendors)('%s: refuses a non-app-access caller and an unauthenticated request', async (vendor) => {
		const url = getUrl(vendor);

		const apiOnly = await request(url)
			.get(`/extension-settings/app?subject=${SUBJECT}`)
			.set('Authorization', `Bearer ${common.USER.API_ONLY.TOKEN}`);
		expect(apiOnly.status).toBe(403);

		const anon = await request(url).get(`/extension-settings/app?subject=${SUBJECT}`);
		expect(anon.status).toBe(401);
	});

	it.each(vendors)('%s: returns an empty object for an absent subject', async (vendor) => {
		const read = await request(getUrl(vendor))
			.get('/extension-settings/app?subject=cairncms-extension-not-installed')
			.set('Authorization', adminAuth);

		expect(read.status).toBe(200);
		expect(read.body.data).toEqual({});
	});

	it.each(vendors)('%s: rejects a missing or non-string parameter with a 400', async (vendor) => {
		const url = getUrl(vendor);

		const noSubject = await request(url).get('/extension-settings/app').set('Authorization', adminAuth);
		expect(noSubject.status).toBe(400);

		const arrayCollection = await request(url)
			.get(`/extension-settings/app?subject=${SUBJECT}&collection=a&collection=b`)
			.set('Authorization', adminAuth);
		expect(arrayCollection.status).toBe(400);
	});

	it.each(vendors)('%s: denies a non-admin the collection value without read permission', async (vendor) => {
		const read = await request(getUrl(vendor))
			.get(`/extension-settings/app?subject=${SUBJECT}&collection=${APP_COLLECTION}`)
			.set('Authorization', `Bearer ${common.USER.APP_ACCESS.TOKEN}`);

		expect(read.status).toBe(200);
		expect(read.body.data).toEqual({ theme: 'dark' });
	});

	it.each(vendors)('%s: returns the collection value to a non-admin granted read permission', async (vendor) => {
		const url = getUrl(vendor);
		const appAuth = `Bearer ${common.USER.APP_ACCESS.TOKEN}`;

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
	const ECHO_SUBJECT = 'cairncms-extension-confined-echo-endpoint';
	const CONFINED_PLAINTEXT = 'sk_live_confined_blackbox_secret';
	const CONFIG_PLAINTEXT = 'confined-billing-secret-value';
	const databases = new Map<string, Knex>();
	const adminAuth = `Bearer ${common.USER.ADMIN.TOKEN}`;

	beforeAll(async () => {
		for (const vendor of vendors) {
			databases.set(vendor, knex(config.knexConfig[vendor]!));
			const url = getUrl(vendor);
			const post = (body: any) => request(url).post('/extension-settings').set('Authorization', adminAuth).send(body);

			const label = await post({
				subject: ECHO_SUBJECT,
				scope: 'global',
				scope_key: '',
				key: 'site_label',
				value: 'Cairn Blackbox',
			});

			expect(label.status).toBe(200);

			const secret = await post({
				subject: ECHO_SUBJECT,
				scope: 'global',
				scope_key: '',
				key: 'api_key',
				value: CONFINED_PLAINTEXT,
			});

			expect(secret.status).toBe(200);
		}
	});

	afterAll(async () => {
		for (const [, db] of databases) {
			await db(TABLE).where({ extension: ECHO_SUBJECT }).del();
			await db.destroy();
		}
	});

	it.each(vendors)(
		'%s: the confined guest reads a value and receives each secret only as a reference',
		async (vendor) => {
			const response = await request(getUrl(vendor)).get(`/${ECHO_SUBJECT}/settings`);

			expect(response.status).toBe(200);
			expect(response.body.label).toBe('Cairn Blackbox');
			expect(response.body.apiKey.kind).toBe('secret-reference');
			expect(typeof response.body.apiKey.ref).toBe('string');
			expect(response.body.billingKey.kind).toBe('secret-reference');
			expect(response.body.undeclared).toBeNull();

			const serialized = JSON.stringify(response.body);
			expect(serialized).not.toContain(CONFINED_PLAINTEXT);
			expect(serialized).not.toContain(CONFIG_PLAINTEXT);
		}
	);

	it.each(vendors)('%s: the admin read of the confined subject masks the secret and skips config keys', async (vendor) => {
		const read = await request(getUrl(vendor))
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
