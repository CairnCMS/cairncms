import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { requestGraphQL } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createIdentityTest().extend<{ metadataState: Prerequisite<void>; metadata: void }>({
	metadataState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					await api.database('directus_collections').insert({ collection: TABLE });
					expect(await api.database('directus_collections').where({ collection: TABLE })).toHaveLength(1);
					await setupRequest(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' }).expect(200);
					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	metadata: [
		async ({ api, identities, metadataState, task, skip }, use) => {
			void api;
			void identities;
			requirePrerequisite(metadataState, 'internal-table metadata row', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

const TABLE = 'cairncms_extension_settings';
const FORBIDDEN = [403, 404];
const TOKEN = () => USER.ADMIN!.TOKEN;

// These assertions pin the HTTP surfaces for the one registered internal table by name.
// Proof that a newly registered internal table is auto-covered lives in the unit suite at
// api/src/database/internal-tables.test.ts, which iterates the registry. The blackbox package
// cannot import that registry, so a new internal table must be added to the checks below by hand.
describe('internal table cairncms_extension_settings stays hidden from every operator surface', () => {
	test('absent from /collections, /collections/:collection, and GraphQL', async ({ api }) => {
		const url = api.url;

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

	test('absent from /fields and /relations', async ({ api }) => {
		const url = api.url;

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

	test('absent from the schema snapshot', async ({ api }) => {
		const snapshot = await request(api.url).get('/schema/snapshot').set('Authorization', `Bearer ${TOKEN()}`);
		const { collections, fields, relations } = snapshot.body.data;

		expect(collections.map((collection: any) => collection.collection)).not.toContain(TABLE);
		expect(fields.some((field: any) => field.collection === TABLE)).toBe(false);

		expect(
			relations.some((relation: any) => relation.collection === TABLE || relation.related_collection === TABLE)
		).toBe(false);
	});

	test('generic /items is forbidden for every collection and item route', async ({ api }) => {
		const url = api.url;

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

	test('generic import and export are forbidden', async ({ api }) => {
		const url = api.url;

		const importResponse = await request(url).post(`/utils/import/${TABLE}`).set('Authorization', `Bearer ${TOKEN()}`);

		const exportResponse = await request(url)
			.post(`/utils/export/${TABLE}`)
			.set('Authorization', `Bearer ${TOKEN()}`)
			.send({ query: {}, format: 'json' });

		expect(FORBIDDEN).toContain(importResponse.status);
		expect(FORBIDDEN).toContain(exportResponse.status);
	});

	test('absent from the OpenAPI spec', async ({ api }) => {
		const spec = await request(api.url).get('/server/specs/oas').set('Authorization', `Bearer ${TOKEN()}`);
		expect(spec.status).toBe(200);
		expect(JSON.stringify(spec.body)).not.toContain(TABLE);
	});
});
