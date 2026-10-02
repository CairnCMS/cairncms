import { beforeEach, afterEach, describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { collectionListingTest as test, DEFAULT_DB_TABLES, clearCollectionFixtures } from './schema-fixtures';
import * as common from '../../fixtures/data';
import request from '../../fixtures/request';
import type { Collection } from '@cairncms/types';
import { findIndex } from 'lodash';
import { requestGraphQL } from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

describe.each(common.PRIMARY_KEY_TYPES)('/collections', (pkType) => {
	const TEST_COLLECTION_NAME = `test_collections_crud_creation_${pkType}`;
	const TEST_FOLDER_NAME = `test_collections_crud_folder_${pkType}`;

	describe(`pkType: ${pkType}`, () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await clearCollectionFixtures(api, pkType);
		});

		afterEach<{ api: Api }>(async ({ api }) => {
			await clearCollectionFixtures(api, pkType);
		});

		describe('GET /', () => {
			describe('Returns the correct tables', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST and GraphQL', async ({ api }) => {
							// Action
							const response = await request(api.url)
								.get('/collections')
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							const gqlResponse = await requestGraphQL(api.url, true, common.USER[userKey].TOKEN, {
								query: {
									collections: {
										collection: true,
									},
								},
							});

							// Assert
							if (userKey === 'ADMIN') {
								const responseData = JSON.parse(response.text);
								const tableNames = responseData.data.map((collection: Collection) => collection.collection).sort();

								const tableNames2 = gqlResponse.body.data['collections']
									.map((collection: Collection) => collection.collection)
									.sort();

								expect(response.statusCode).toBe(200);
								expect(responseData.data.length).toBeGreaterThanOrEqual(DEFAULT_DB_TABLES.length);

								expect(
									DEFAULT_DB_TABLES.every((name: string) => {
										return tableNames.indexOf(name) !== -1;
									})
								).toEqual(true);

								expect(gqlResponse.statusCode).toBe(200);

								expect(gqlResponse.body.data['collections'].length).toBeGreaterThanOrEqual(DEFAULT_DB_TABLES.length);

								expect(
									DEFAULT_DB_TABLES.every((name: string) => {
										return tableNames2.indexOf(name) !== -1;
									})
								).toEqual(true);
							} else if (userKey === 'APP_ACCESS') {
								const responseData = JSON.parse(response.text);
								const tableNames = responseData.data.map((collection: Collection) => collection.collection).sort();

								const tableNames2 = gqlResponse.body.data['collections']
									.map((collection: Collection) => collection.collection)
									.sort();

								const appAccessPermissions = [
									'directus_activity',
									'directus_collections',
									'directus_fields',
									'directus_notifications',
									'directus_permissions',
									'directus_presets',
									'directus_relations',
									'directus_roles',
									'directus_settings',
									'directus_shares',
									'directus_users',
								];

								expect(response.statusCode).toBe(200);
								expect(responseData.data.length).toBeGreaterThanOrEqual(appAccessPermissions.length);

								expect(
									appAccessPermissions.every((name: string) => {
										return tableNames.indexOf(name) !== -1;
									})
								).toEqual(true);

								expect(gqlResponse.statusCode).toBe(200);
								expect(gqlResponse.body.data['collections'].length).toBeGreaterThanOrEqual(appAccessPermissions.length);

								expect(
									appAccessPermissions.every((name: string) => {
										return tableNames2.indexOf(name) !== -1;
									})
								).toEqual(true);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});

		describe('POST /', () => {
			describe('Creates a new regular collection', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							const fields = [];

							switch (pkType) {
								case 'uuid':
									fields.push({
										field: 'id',
										type: 'uuid',
										meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] },
										schema: { is_primary_key: true, length: 36, has_auto_increment: false },
									});

									break;
								case 'string':
									fields.push({
										field: 'id',
										type: 'string',
										meta: { hidden: false, readonly: false, interface: 'input' },
										schema: { is_primary_key: true, length: 255, has_auto_increment: false },
									});

									break;
								case 'integer':
									fields.push({
										field: 'id',
										type: 'integer',
										meta: { hidden: true, interface: 'input', readonly: true },
										schema: { is_primary_key: true, has_auto_increment: true },
									});

									break;
							}

							// Action
							const response = await request(api.url)
								.post('/collections')
								.send({ collection: TEST_COLLECTION_NAME, meta: {}, schema: {}, fields })
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual({
									collection: TEST_COLLECTION_NAME,
									meta: expect.objectContaining({
										collection: TEST_COLLECTION_NAME,
									}),
									schema: expect.objectContaining({
										name: TEST_COLLECTION_NAME,
									}),
								});

								expect(await db.schema.hasTable(TEST_COLLECTION_NAME)).toBe(true);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});

			describe('Creates a new folder', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							// Action
							const response = await request(api.url)
								.post('/collections')
								.send({ collection: TEST_FOLDER_NAME, meta: {}, schema: null })
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual({
									collection: TEST_FOLDER_NAME,
									meta: expect.objectContaining({
										collection: TEST_FOLDER_NAME,
									}),
									schema: null,
								});

								expect(await db.schema.hasTable(TEST_FOLDER_NAME)).toBe(false);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});

		describe('PATCH /', () => {
			const collectionNames = [
				`test_collections_crud_batch_update_${pkType}`,
				`test_collections_crud_batch_update2_${pkType}`,
				`test_collections_crud_batch_update3_${pkType}`,
			];

			const newSortOrder = [3, 1, 2];

			describe('Does batch update used for collection sorting', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							// Action
							await request(api.url)
								.post('/collections')
								.send(
									collectionNames.map((collection) => {
										return { collection, meta: {}, schema: {} };
									})
								)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							let index = 0;

							const response = await request(api.url)
								.patch('/collections')
								.send(
									collectionNames.map((collection) => {
										const sort = newSortOrder[index++];
										return { collection, meta: { sort, note: String(sort) } };
									})
								)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								for (let i = 0; i < collectionNames.length; i++) {
									const matchedIndex = findIndex(response.body.data, { collection: collectionNames[i] });

									expect(response.body.data[matchedIndex]).toEqual({
										collection: collectionNames[i],
										meta: expect.objectContaining({
											collection: collectionNames[i],
											sort: newSortOrder[i],
											note: String(newSortOrder[i]),
										}),
										schema: expect.objectContaining({
											name: collectionNames[i],
										}),
									});

									expect(await db.schema.hasTable(collectionNames[i])).toBe(true);
								}
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});

		describe('DELETE /', () => {
			describe('Deletes a regular collection', () => {
				common.TEST_USERS.forEach((userKey: string) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							await request(api.url)
								.post('/collections')
								.send({ collection: TEST_COLLECTION_NAME, meta: {}, schema: {} })
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							if (userKey === 'ADMIN') {
								expect(await db.schema.hasTable(TEST_COLLECTION_NAME)).toBe(true);
							}

							// Action
							const response = await request(api.url)
								.delete('/collections/' + TEST_COLLECTION_NAME)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(204);
								expect(response.body).toEqual({});
								expect(await db.schema.hasTable(TEST_COLLECTION_NAME)).toBe(false);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});

			describe('Deletes a folder', () => {
				common.TEST_USERS.forEach((userKey: string) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							await request(api.url)
								.post('/collections')
								.send({ collection: TEST_FOLDER_NAME, meta: {}, schema: null })
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							if (userKey === 'ADMIN') {
								expect(await db('directus_collections').select().where({ collection: TEST_FOLDER_NAME })).toHaveLength(
									1
								);
							}

							// Action
							const response = await request(api.url)
								.delete('/collections/' + TEST_FOLDER_NAME)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(204);
								expect(response.body).toEqual({});

								expect(await db('directus_collections').select().where({ collection: TEST_FOLDER_NAME })).toHaveLength(
									0
								);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});
	});
});

describe('Clear Caches', () => {
	test('REST', async ({ api }) => {
		const cached = await api.start({ CACHE_SCHEMA: 'true' });

		const response = await request(cached.url)
			.post('/utils/cache/clear')
			.auth(common.USER.ADMIN.TOKEN, { type: 'bearer' });

		const response2 = await request(cached.url).get('/fields').auth(common.USER.ADMIN.TOKEN, { type: 'bearer' });
		expect(response.statusCode).toBe(200);
		expect(response2.statusCode).toBe(200);
	});
});
