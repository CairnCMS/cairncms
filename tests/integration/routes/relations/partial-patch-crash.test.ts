import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { apiTest, type Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateFieldM2O } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const PARENT_COLLECTION = 'test_relations_partial_patch_parent';
const CHILD_COLLECTION = 'test_relations_partial_patch_child';
const FK_FIELD = 'parent';

const test = apiTest.extend<{ schemaState: Prerequisite<void>; schemaReady: void }>({
	schemaState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					try {
						await CreateCollection(api, { collection: PARENT_COLLECTION });
						await CreateCollection(api, { collection: CHILD_COLLECTION });

						await CreateFieldM2O(api, {
							collection: CHILD_COLLECTION,
							field: FK_FIELD,
							otherCollection: PARENT_COLLECTION,
						});

						await ready();
					} finally {
						if (api.available()) {
							for (const collection of [CHILD_COLLECTION, PARENT_COLLECTION]) {
								try {
									await setupRequest(api.url)
										.delete(`/collections/${collection}`)
										.auth(api.adminToken, { type: 'bearer' })
										.expect(204);
								} catch (error) {
									teardownFailures.push(error);
								}
							}
						}
					}
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'test' },
	],
	schemaReady: [
		async ({ api, schemaState, task, skip }, use) => {
			void api;
			requirePrerequisite(schemaState, 'collection and relation prerequisites', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

async function preparePatchedRelation(api: Api, full: boolean) {
	const partial = await request(api.url)
		.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
		.auth(api.adminToken, { type: 'bearer' })
		.send({ meta: { one_field: 'children_via_partial_patch' } })
		.expect(200);

	expect(partial.body.data.meta.one_field).toBe('children_via_partial_patch');
	expect(partial.body.data.schema.on_delete).toBe('SET NULL');

	if (full) {
		const patched = await request(api.url)
			.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
			.auth(api.adminToken, { type: 'bearer' })
			.send({
				collection: CHILD_COLLECTION,
				field: FK_FIELD,
				related_collection: PARENT_COLLECTION,
				meta: { one_field: 'children_via_full_patch' },
				schema: { on_delete: 'CASCADE' },
			})
			.expect(200);

		expect(patched.body.data.meta.one_field).toBe('children_via_full_patch');
		expect(patched.body.data.schema.on_delete).toBe('CASCADE');
	}
}

describe(`/relations PATCH partial body`, () => {
	describe('PATCH /relations/:collection/:field with a partial body succeeds and the API process stays alive', () => {
		test('preserves the relation and keeps the API alive', async ({ api }) => {
			const alias = 'children_via_partial_patch';

			const response = await request(api.url)
				.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({ meta: { one_field: alias } });

			expect(response.statusCode).toBe(200);
			expect(response.body.data.meta.one_field).toBe(alias);
			expect(response.body.data.schema.on_delete).toBe('SET NULL');

			const ping = await request(api.url).get('/server/ping');

			expect(ping.statusCode).toBe(200);
			expect(ping.text).toBe('pong');
		});
	});

	describe('PATCH /relations/:collection/:field with a full body still succeeds (regression)', () => {
		test('preserves the relation and keeps the API alive', async ({ api }) => {
			await preparePatchedRelation(api, false);
			const alias = 'children_via_full_patch';

			const response = await request(api.url)
				.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({
					collection: CHILD_COLLECTION,
					field: FK_FIELD,
					related_collection: PARENT_COLLECTION,
					meta: { one_field: alias },
					schema: { on_delete: 'CASCADE' },
				});

			expect(response.statusCode).toBe(200);
			expect(response.body.data.meta.one_field).toBe(alias);
			expect(response.body.data.schema.on_delete).toBe('CASCADE');

			const ping = await request(api.url).get('/server/ping');

			expect(ping.statusCode).toBe(200);
			expect(ping.text).toBe('pong');
		});
	});

	describe('PATCH /relations/:collection/:field with an explicit schema: null does not crash the API process', () => {
		test('preserves the relation and keeps the API alive', async ({ api }) => {
			await preparePatchedRelation(api, true);

			const response = await request(api.url)
				.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({ schema: null });

			expect(response.statusCode).toBe(200);

			const ping = await request(api.url).get('/server/ping');

			expect(ping.statusCode).toBe(200);
			expect(ping.text).toBe('pong');
		});
	});
});
