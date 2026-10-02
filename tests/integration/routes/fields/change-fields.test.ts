import { beforeEach, afterEach, describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createScenarioTest } from '../../fixtures/scenario';
import request from '../../fixtures/request';

import { CreateField } from '../../fixtures/data';
import { CachedTestsSchema, TestsSchemaVendorValues } from '../../query/filter';
import * as common from '../../fixtures/data';
import {
	collectionCountries,
	collectionStates,
	getTestsSchema,
	seedDBValues,
	seedDBStructure,
} from './change-fields.seed';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const cachedSchema = common.PRIMARY_KEY_TYPES.reduce((acc, pkType) => {
	acc[pkType] = getTestsSchema(pkType);
	return acc;
}, {} as CachedTestsSchema);

const vendorSchemaValues: TestsSchemaVendorValues = {};

const test = createScenarioTest({
	environment: { env: { CACHE_SCHEMA: 'false' } },
	prepare: async (api, vendor) => {
		await seedDBStructure(api);
		await seedDBValues(api, vendor, cachedSchema, vendorSchemaValues);
	},
	cleanup: async () => {
		/* The owned database is dropped after the API exits. */
	},
});

async function clearChanges(api: Api, pkType: common.PrimaryKeyType) {
	const collection = collectionCountries + '_' + pkType;

	for (const field of ['to_be_deleted', 'flag_image', 'test_divider']) {
		const rows = await api.database('directus_fields').where({ collection, field });
		if (rows.length)
			await request(api.url)
				.delete('/fields/' + collection + '/' + field)
				.auth(common.USER.ADMIN.TOKEN, { type: 'bearer' })
				.expect(204);
	}

	await api
		.database('directus_fields')
		.where({ collection: collectionStates + '_' + pkType, field: 'country_id' })
		.update({ options: null });
}

async function prepareDivider(api: Api, collection: string) {
	await request(api.url)
		.post('/fields/' + collection)
		.auth(common.USER.ADMIN.TOKEN, { type: 'bearer' })
		.send({
			field: 'test_divider',
			type: 'alias',
			meta: { interface: 'presentation-divider', special: ['alias', 'no-data'], options: { title: 'Test Divider' } },
			collection,
		})
		.expect(200);
}

describe('Seed Database Values', () => {
	test('REST', async ({ vendor }) => {
		// Assert
		expect(vendorSchemaValues[vendor]).toBeDefined();
	});
});

describe.each(common.PRIMARY_KEY_TYPES)('/fields', (pkType) => {
	const localCollectionCountries = `${collectionCountries}_${pkType}`;
	const localCollectionStates = `${collectionStates}_${pkType}`;

	describe(`pkType: ${pkType}`, () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await clearChanges(api, pkType);
		});

		afterEach<{ api: Api }>(async ({ api }) => {
			await clearChanges(api, pkType);
		});

		describe('DELETE /:collection/:field', () => {
			describe('with foreign key constraints does not clear existing data', () => {
				test('REST', async ({ api }) => {
					// Setup
					const newFieldName = 'to_be_deleted';

					const response = await request(api.url)
						.get(`/items/${localCollectionStates}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const existingData = response.body.data;

					// Action
					await CreateField(api, {
						collection: localCollectionCountries,
						field: newFieldName,
						type: 'string',
					});

					await DeleteField(api, {
						collection: localCollectionCountries,
						field: newFieldName,
					});

					const response2 = await request(api.url)
						.get(`/items/${localCollectionStates}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const updatedData = response2.body.data;

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response2.statusCode).toEqual(200);
					expect(existingData).toHaveLength(4);
					expect(existingData).toStrictEqual(updatedData);
				});
			});
		});

		describe('POST /:collection', () => {
			describe('with new relations does not clear existing data', () => {
				test('REST', async ({ api }) => {
					// Setup
					const fieldName = 'flag_image';

					const response = await request(api.url)
						.get(`/items/${localCollectionStates}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const existingData = response.body.data;

					// Action
					await request(api.url)
						.post(`/fields/${localCollectionCountries}`)
						.send({
							field: fieldName,
							type: 'uuid',
							schema: {},
							meta: { interface: 'file-image', special: ['file'] },
							collection: localCollectionCountries,
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					await request(api.url)
						.post(`/relations`)
						.send({
							collection: localCollectionCountries,
							field: fieldName,
							related_collection: 'directus_files',
							meta: { sort_field: null },
							schema: { on_delete: 'SET NULL' },
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/items/${localCollectionStates}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const updatedData = response2.body.data;

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response2.statusCode).toEqual(200);
					expect(existingData).toHaveLength(4);
					expect(existingData).toStrictEqual(updatedData);
				});
			});

			describe('can create new virtual alias field', () => {
				test('REST', async ({ api }) => {
					// Setup
					const fieldName = 'test_divider';

					// Action
					const response = await request(api.url)
						.post(`/fields/${localCollectionCountries}`)
						.send({
							field: fieldName,
							type: 'alias',
							meta: {
								interface: 'presentation-divider',
								special: ['alias', 'no-data'],
								options: { title: 'Test Divider' },
							},
							collection: localCollectionCountries,
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/fields/${localCollectionCountries}/${fieldName}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response2.statusCode).toEqual(200);

					expect(response2.body.data).toEqual(
						expect.objectContaining({
							field: fieldName,
							type: 'alias',
							collection: localCollectionCountries,
						})
					);
				});
			});
		});

		describe('PATCH /:collection', () => {
			describe('can sort virtual alias field', () => {
				beforeEach<{ api: Api }>(async ({ api }) => {
					await prepareDivider(api, localCollectionCountries);
				});

				test('REST', async ({ api }) => {
					// Setup
					const fieldName = 'test_divider';
					const updatedSort = 100;

					// Action
					const response = await request(api.url)
						.patch(`/fields/${localCollectionCountries}`)
						.send([{ field: 'test_divider', meta: { sort: updatedSort, group: null } }])
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/fields/${localCollectionCountries}/${fieldName}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response2.statusCode).toEqual(200);

					expect(response2.body.data).toEqual(
						expect.objectContaining({
							field: fieldName,
							type: 'alias',
							meta: expect.objectContaining({
								sort: updatedSort,
							}),
							collection: localCollectionCountries,
						})
					);
				});
			});
		});

		describe('PATCH /:collection/:field', () => {
			describe('can update virtual alias field', () => {
				beforeEach<{ api: Api }>(async ({ api }) => {
					await prepareDivider(api, localCollectionCountries);
				});

				test('REST', async ({ api }) => {
					// Setup
					const fieldName = 'test_divider';
					const updatedTitle = 'Updated Divider';

					// Action
					const response = await request(api.url)
						.patch(`/fields/${localCollectionCountries}/${fieldName}`)
						.send({
							collection: localCollectionCountries,
							field: fieldName,
							type: 'alias',
							schema: null,
							meta: {
								options: { title: updatedTitle },
							},
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/fields/${localCollectionCountries}/${fieldName}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response2.statusCode).toEqual(200);

					expect(response2.body.data).toEqual(
						expect.objectContaining({
							field: fieldName,
							type: 'alias',
							meta: expect.objectContaining({
								options: expect.objectContaining({ title: updatedTitle }),
							}),
							collection: localCollectionCountries,
						})
					);
				});
			});

			describe('can update meta only without schema changes for relational field', () => {
				test('REST', async ({ api }) => {
					// Setup
					const fieldName = 'country_id';

					const payload = (
						await request(api.url)
							.get(`/fields/${localCollectionStates}/${fieldName}`)
							.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					).body.data;

					payload.meta.options = { template: 'updated' };

					// Action
					const response = await request(api.url)
						.patch(`/fields/${localCollectionStates}/${fieldName}`)
						.send(payload)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/fields/${localCollectionStates}/${fieldName}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response2.statusCode).toEqual(200);
					expect(response2.body.data).toEqual(payload);
				});
			});
		});
	});
});

describe.each(common.PRIMARY_KEY_TYPES)('/fields', (pkType) => {
	describe(`pkType: ${pkType}`, () => {
		describe('Clear Caches', () => {
			test('REST', async ({ api }) => {
				const cached = await api.start({ CACHE_SCHEMA: 'true' });
				const response = await request(cached.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' });
				const response2 = await request(cached.url).get('/fields').auth(api.adminToken, { type: 'bearer' });
				expect(response.statusCode).toBe(200);
				expect(response2.statusCode).toBe(200);
			});
		});
	});
});

async function DeleteField(api: Api, options: { collection: string; field: string }) {
	const response = await request(api.url)
		.delete(`/fields/${options.collection}/${options.field}`)
		.auth(api.adminToken, { type: 'bearer' });

	return response.body;
}
