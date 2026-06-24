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

	it.each(vendors)('%s: round-trips a value, stores a secret pointer unresolved, and purges', async (vendor) => {
		const url = getUrl(vendor);
		const auth = `Bearer ${TOKEN()}`;

		const set = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'base_url', value: 'https://preview.example.com' });

		expect(set.status).toBe(200);

		const setSecret = await request(url)
			.post('/extension-settings')
			.set('Authorization', auth)
			.send({
				subject: SUBJECT,
				scope: 'global',
				scope_key: '',
				key: 'api_key',
				value: { source: 'config', name: 'MY_API_KEY' },
			});

		expect(setSecret.status).toBe(200);

		const read = await request(url).get(`/extension-settings?subject=${SUBJECT}`).set('Authorization', auth);
		expect(read.status).toBe(200);

		const byKey = Object.fromEntries(read.body.data.map((row: any) => [row.key, row.value]));
		expect(byKey.base_url).toBe('https://preview.example.com');
		expect(byKey.api_key).toEqual({ source: 'config', name: 'MY_API_KEY' });

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
		expect((await post({ subject: SUBJECT, scope: 'global', scope_key: '', key: 'api_key', value: 'raw' })).status).toBe(
			400
		);
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
