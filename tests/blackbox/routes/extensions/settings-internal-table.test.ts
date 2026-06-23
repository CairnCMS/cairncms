import config, { getUrl } from '@common/config';
import * as common from '@common/index';
import { requestGraphQL } from '@common/index';
import vendors from '@common/get-dbs-to-test';
import knex, { type Knex } from 'knex';
import request from 'supertest';

const TABLE = 'cairncms_extension_settings';
const FORBIDDEN = [403, 404];
const TOKEN = () => common.USER.ADMIN.TOKEN;

describe('internal table cairncms_extension_settings stays hidden from every operator surface', () => {
	const databases = new Map<string, Knex>();

	beforeAll(async () => {
		for (const vendor of vendors) {
			const db = knex(config.knexConfig[vendor]!);
			databases.set(vendor, db);
			// A directus_collections metadata row pins the metadata-leak path: an internal table
			// must stay hidden even when it has a collection metadata row, not only a physical table.
			// Delete-then-insert keeps the seed idempotent and portable across every blackbox vendor.
			await db('directus_collections').del().where({ collection: TABLE });
			await db('directus_collections').insert({ collection: TABLE });
		}
	});

	afterAll(async () => {
		for (const [, db] of databases) {
			await db('directus_collections').del().where({ collection: TABLE });
			await db.destroy();
		}
	});

	it.each(vendors)('%s: absent from /collections, /collections/:collection, and GraphQL', async (vendor) => {
		const url = getUrl(vendor);

		const list = await request(url).get('/collections').set('Authorization', `Bearer ${TOKEN()}`);
		expect(list.body.data.map((collection: any) => collection.collection)).not.toContain(TABLE);

		const one = await request(url).get(`/collections/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`);
		expect(FORBIDDEN).toContain(one.status);

		const gql = await requestGraphQL(url, true, TOKEN(), { query: { collections: { collection: true } } });
		expect(gql.body.data.collections.map((collection: any) => collection.collection)).not.toContain(TABLE);

		const itemGql = await requestGraphQL(url, false, TOKEN(), { query: { [TABLE]: { id: true } } });
		expect(itemGql.body.errors).toBeDefined();
		expect(itemGql.body.data?.[TABLE]).toBeUndefined();
	});

	it.each(vendors)('%s: absent from /fields and /relations', async (vendor) => {
		const url = getUrl(vendor);

		const fields = await request(url).get('/fields').set('Authorization', `Bearer ${TOKEN()}`);
		expect(fields.body.data.some((field: any) => field.collection === TABLE)).toBe(false);

		const scopedFields = await request(url).get(`/fields/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`);
		expect(FORBIDDEN).toContain(scopedFields.status);

		const relations = await request(url).get('/relations').set('Authorization', `Bearer ${TOKEN()}`);
		expect(
			relations.body.data.some(
				(relation: any) => relation.collection === TABLE || relation.related_collection === TABLE
			)
		).toBe(false);
	});

	it.each(vendors)('%s: absent from the schema snapshot', async (vendor) => {
		const snapshot = await request(getUrl(vendor)).get('/schema/snapshot').set('Authorization', `Bearer ${TOKEN()}`);
		const { collections, fields, relations } = snapshot.body.data;

		expect(collections.map((collection: any) => collection.collection)).not.toContain(TABLE);
		expect(fields.some((field: any) => field.collection === TABLE)).toBe(false);
		expect(
			relations.some((relation: any) => relation.collection === TABLE || relation.related_collection === TABLE)
		).toBe(false);
	});

	it.each(vendors)('%s: generic /items is forbidden for every collection and item route', async (vendor) => {
		const url = getUrl(vendor);

		const responses = await Promise.all([
			request(url).get(`/items/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`),
			request(url).search(`/items/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`).send({ query: {} }),
			request(url).post(`/items/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`).send({}),
			request(url).patch(`/items/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`).send({}),
			request(url).delete(`/items/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`).send([]),
			request(url).get(`/items/${TABLE}/1`).set('Authorization', `Bearer ${TOKEN()}`),
			request(url).patch(`/items/${TABLE}/1`).set('Authorization', `Bearer ${TOKEN()}`).send({}),
			request(url).delete(`/items/${TABLE}/1`).set('Authorization', `Bearer ${TOKEN()}`),
		]);

		for (const response of responses) expect(FORBIDDEN).toContain(response.status);
	});

	it.each(vendors)('%s: generic import and export are forbidden', async (vendor) => {
		const url = getUrl(vendor);

		const importResponse = await request(url).post(`/utils/import/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`);

		const exportResponse = await request(url)
			.post(`/utils/export/${TABLE}`)
			.set('Authorization', `Bearer ${TOKEN()}`)
			.send({ query: {}, format: 'json' });

		expect(FORBIDDEN).toContain(importResponse.status);
		expect(FORBIDDEN).toContain(exportResponse.status);
	});

	it.each(vendors)('%s: absent from the OpenAPI spec', async (vendor) => {
		const spec = await request(getUrl(vendor)).get('/server/specs/oas').set('Authorization', `Bearer ${TOKEN()}`);
		expect(spec.status).toBe(200);
		expect(JSON.stringify(spec.body)).not.toContain(TABLE);
	});
});
