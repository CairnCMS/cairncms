import { beforeEach, afterEach, describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { fieldsTest as test, DEFAULT_DB_TABLES, resetFields } from './schema-fixtures';
import * as common from '../../fixtures/data';
import request from '../../fixtures/request';
import type { FieldRaw } from '@cairncms/types';
import { sortedUniq } from 'lodash';
import { requestGraphQL } from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const collection = 'test_fields_crud';

initializeFixtures();

describe.each(common.PRIMARY_KEY_TYPES)('/fields', (pkType) => {
	const TEST_COLLECTION_NAME = `${collection}_${pkType}`;
	const TEST_FIELD_NAME = 'test_field';
	const TEST_ALIAS_FIELD_NAME = 'test_alias_field';
	const TEST_UPDATED_NOTE = 'updated-note';

	describe(`pkType: ${pkType}`, () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await resetFields(api, pkType, false);
		});

		afterEach<{ api: Api }>(async ({ api }) => {
			await resetFields(api, pkType, false);
		});

		describe('GET /', () => {
			describe('Returns the correct fields', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST and GraphQL', async ({ api }) => {
							// Action
							const response = await request(api.url)
								.get('/collections')
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							const gqlResponse = await requestGraphQL(api.url, true, common.USER[userKey].TOKEN, {
								query: {
									fields: {
										field: true,
										collection: true,
									},
								},
							});

							// Assert
							if (userKey === 'ADMIN') {
								const responseData = JSON.parse(response.text);
								const tableNames = sortedUniq(responseData.data.map((field: FieldRaw) => field.collection));

								const tableNames2 = sortedUniq(
									gqlResponse.body.data['fields'].map((field: FieldRaw) => field.collection)
								);

								expect(response.statusCode).toBe(200);
								expect(tableNames.length).toBeGreaterThanOrEqual(DEFAULT_DB_TABLES.length);

								expect(
									DEFAULT_DB_TABLES.every((name: string) => {
										return tableNames.indexOf(name) !== -1;
									})
								).toEqual(true);

								expect(gqlResponse.statusCode).toBe(200);
								expect(tableNames2.length).toBeGreaterThanOrEqual(DEFAULT_DB_TABLES.length);

								expect(
									DEFAULT_DB_TABLES.every((name: string) => {
										return tableNames2.indexOf(name) !== -1;
									})
								).toEqual(true);
							} else if (userKey === 'APP_ACCESS') {
								const responseData = JSON.parse(response.text);
								const tableNames = sortedUniq(responseData.data.map((field: FieldRaw) => field.collection));

								const tableNames2 = sortedUniq(
									gqlResponse.body.data['fields'].map((field: FieldRaw) => field.collection)
								);

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
								expect(tableNames.length).toBeGreaterThanOrEqual(appAccessPermissions.length);

								expect(
									appAccessPermissions.every((name: string) => {
										return tableNames.indexOf(name) !== -1;
									})
								).toEqual(true);

								expect(gqlResponse.statusCode).toBe(200);
								expect(tableNames2.length).toBeGreaterThanOrEqual(appAccessPermissions.length);

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

		describe('POST /:collection', () => {
			describe('Creates a new field', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							// Action
							const response = await request(api.url)
								.post(`/fields/${TEST_COLLECTION_NAME}`)
								.send({
									collection: TEST_COLLECTION_NAME,
									field: TEST_FIELD_NAME,
									meta: {},
									schema: {},
									type: 'string',
								})
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual({
									collection: TEST_COLLECTION_NAME,
									field: TEST_FIELD_NAME,
									meta: expect.objectContaining({
										collection: TEST_COLLECTION_NAME,
										field: TEST_FIELD_NAME,
									}),
									schema: expect.objectContaining({
										name: TEST_FIELD_NAME,
										table: TEST_COLLECTION_NAME,
									}),
									type: 'string',
								});

								expect(await db.schema.hasColumn(TEST_COLLECTION_NAME, TEST_FIELD_NAME)).toBe(true);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});

			describe('Creates a new alias field', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							// Action
							const response = await request(api.url)
								.post(`/fields/${TEST_COLLECTION_NAME}`)
								.send({
									collection: TEST_COLLECTION_NAME,
									field: TEST_ALIAS_FIELD_NAME,
									meta: { interface: 'group-raw', special: ['alias', 'no-data', 'group'] },
									type: 'alias',
								})
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual({
									collection: TEST_COLLECTION_NAME,
									field: TEST_ALIAS_FIELD_NAME,
									meta: expect.objectContaining({
										collection: TEST_COLLECTION_NAME,
										field: TEST_ALIAS_FIELD_NAME,
										interface: 'group-raw',
										special: ['alias', 'no-data', 'group'],
									}),
									schema: null,
									type: 'alias',
								});

								expect(await db.schema.hasColumn(TEST_COLLECTION_NAME, TEST_ALIAS_FIELD_NAME)).toBe(false);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});

		describe('PATCH /:collection/:field', () => {
			beforeEach<{ api: Api }>(async ({ api }) => {
				await resetFields(api, pkType, true);
			});

			describe('Updates field', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup

							// Action
							const response = await request(api.url)
								.patch(`/fields/${TEST_COLLECTION_NAME}/${TEST_FIELD_NAME}`)
								.send({ collection: TEST_COLLECTION_NAME, field: TEST_FIELD_NAME, meta: { note: TEST_UPDATED_NOTE } })
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual({
									collection: TEST_COLLECTION_NAME,
									field: TEST_FIELD_NAME,
									meta: expect.objectContaining({
										collection: TEST_COLLECTION_NAME,
										field: TEST_FIELD_NAME,
										note: TEST_UPDATED_NOTE,
									}),
									schema: expect.objectContaining({
										name: TEST_FIELD_NAME,
										table: TEST_COLLECTION_NAME,
									}),
									type: 'string',
								});
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});

			describe('Updates alias field', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup

							// Action
							const response = await request(api.url)
								.patch(`/fields/${TEST_COLLECTION_NAME}/${TEST_ALIAS_FIELD_NAME}`)
								.send({
									collection: TEST_COLLECTION_NAME,
									field: TEST_ALIAS_FIELD_NAME,
									meta: { note: TEST_UPDATED_NOTE },
								})
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual({
									collection: TEST_COLLECTION_NAME,
									field: TEST_ALIAS_FIELD_NAME,
									meta: expect.objectContaining({
										collection: TEST_COLLECTION_NAME,
										field: TEST_ALIAS_FIELD_NAME,
										note: TEST_UPDATED_NOTE,
									}),
									schema: null,
									type: 'alias',
								});
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});

		describe('PATCH /:collection', () => {
			beforeEach<{ api: Api }>(async ({ api }) => {
				await resetFields(api, pkType, true);
			});

			describe('Updates multiple fields at once', () => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup

							// Action
							const response = await request(api.url)
								.patch(`/fields/${TEST_COLLECTION_NAME}`)
								.send([
									{ collection: TEST_COLLECTION_NAME, field: TEST_FIELD_NAME, meta: { note: TEST_UPDATED_NOTE } },
									{
										collection: TEST_COLLECTION_NAME,
										field: TEST_ALIAS_FIELD_NAME,
										meta: { note: TEST_UPDATED_NOTE },
									},
								])
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(200);

								expect(response.body.data).toEqual([
									{
										collection: TEST_COLLECTION_NAME,
										field: TEST_FIELD_NAME,
										meta: expect.objectContaining({
											collection: TEST_COLLECTION_NAME,
											field: TEST_FIELD_NAME,
											note: TEST_UPDATED_NOTE,
										}),
										schema: expect.objectContaining({
											name: TEST_FIELD_NAME,
											table: TEST_COLLECTION_NAME,
										}),
										type: 'string',
									},
									{
										collection: TEST_COLLECTION_NAME,
										field: TEST_ALIAS_FIELD_NAME,
										meta: expect.objectContaining({
											collection: TEST_COLLECTION_NAME,
											field: TEST_ALIAS_FIELD_NAME,
											note: TEST_UPDATED_NOTE,
										}),
										schema: null,
										type: 'alias',
									},
								]);
							} else {
								expect(response.statusCode).toBe(403);
							}
						});
					});
				});
			});
		});

		describe('DELETE /', () => {
			beforeEach<{ api: Api }>(async ({ api }) => {
				await resetFields(api, pkType, true);
			});

			describe('Deletes a field', () => {
				common.TEST_USERS.forEach((userKey: string) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							// Action
							const response = await request(api.url)
								.delete(`/fields/${TEST_COLLECTION_NAME}/${TEST_FIELD_NAME}`)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							const response2 = await request(api.url)
								.get(`/fields/${TEST_COLLECTION_NAME}/${TEST_FIELD_NAME}`)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(204);
								expect(response.body).toEqual({});
								expect(await db.schema.hasColumn(TEST_COLLECTION_NAME, TEST_FIELD_NAME)).toBe(false);
							} else {
								expect(response.statusCode).toBe(403);
							}

							expect(response2.statusCode).toBe(403);
						});
					});
				});
			});

			describe('Deletes an alias field', () => {
				common.TEST_USERS.forEach((userKey: string) => {
					describe(common.USER[userKey].NAME, () => {
						test('REST', async ({ api }) => {
							// Setup
							const db = api.database;

							// Action
							const response = await request(api.url)
								.delete(`/fields/${TEST_COLLECTION_NAME}/${TEST_ALIAS_FIELD_NAME}`)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							const response2 = await request(api.url)
								.get(`/fields/${TEST_COLLECTION_NAME}/${TEST_ALIAS_FIELD_NAME}`)
								.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

							// Assert
							if (userKey === 'ADMIN') {
								expect(response.statusCode).toBe(204);
								expect(response.body).toEqual({});
								expect(await db.schema.hasColumn(TEST_COLLECTION_NAME, TEST_ALIAS_FIELD_NAME)).toBe(false);
							} else {
								expect(response.statusCode).toBe(403);
							}

							expect(response2.statusCode).toBe(403);
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
