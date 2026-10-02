import { beforeEach, describe, expect } from 'vitest';
import { createApiTest, type Api } from '../fixtures/environment';
import { resetCommon, prepareSchema, prepareItems, removePreviousFields } from './fixtures';
import request from '../fixtures/request';
import * as common from './functions';
import { collectionName, collectionNameM2O, collectionNameO2M } from './fixtures';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

const test = createApiTest({ env: { CACHE_SCHEMA: 'false' } });

initializeFixtures();

describe('Common', () => {
	beforeEach<{ api: Api }>(async ({ api }) => {
		await resetCommon(api);
	});

	describe('createRole()', () => {
		describe('Creates default admin role', () => {
			test('REST', async ({ api }) => {
				// Setup
				const roleName = common.ROLE.ADMIN.NAME;

				const options: common.OptionsCreateRole = {
					name: roleName,
					appAccessEnabled: true,
					adminAccessEnabled: true,
				};

				// Action
				await common.CreateRole(api, options);

				// Assert
				const response = await request(api.url)
					.get(`/roles`)
					.query({
						filter: { name: { _eq: roleName } },
						fields: ['id', 'name', 'app_access', 'admin_access'],
						limit: 1,
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						name: roleName,
						app_access: true,
						admin_access: true,
					},
				]);
			});
		});

		describe('Creates default app access role', () => {
			test('REST', async ({ api }) => {
				// Setup
				const roleName = common.ROLE.APP_ACCESS.NAME;

				const options: common.OptionsCreateRole = {
					name: roleName,
					appAccessEnabled: true,
					adminAccessEnabled: false,
				};

				// Action
				await common.CreateRole(api, options);

				const response = await request(api.url)
					.get(`/roles`)
					.query({
						filter: { name: { _eq: roleName } },
						fields: ['id', 'name', 'app_access', 'admin_access'],
						limit: 1,
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						name: roleName,
						app_access: true,
						admin_access: false,
					},
				]);
			});
		});

		describe('Creates default API only role', () => {
			test('REST', async ({ api }) => {
				// Setup
				const roleName = common.ROLE.API_ONLY.NAME;

				const options: common.OptionsCreateRole = {
					name: roleName,
					appAccessEnabled: false,
					adminAccessEnabled: false,
				};

				// Action
				await common.CreateRole(api, options);

				const response = await request(api.url)
					.get(`/roles`)
					.query({
						filter: { name: { _eq: roleName } },
						fields: ['id', 'name', 'app_access', 'admin_access'],
						limit: 1,
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						name: roleName,
						app_access: false,
						admin_access: false,
					},
				]);
			});
		});
	});

	describe('createUser()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			for (const key of ['ADMIN', 'APP_ACCESS', 'API_ONLY'] as const)
				await common.CreateRole(api, {
					name: common.ROLE[key].NAME,
					adminAccessEnabled: key === 'ADMIN',
					appAccessEnabled: key !== 'API_ONLY',
				});
		});

		describe('Creates default admin user', () => {
			test('REST', async ({ api }) => {
				// Setup
				const token = common.USER.ADMIN.TOKEN;
				const email = common.USER.ADMIN.EMAIL;
				const password = common.USER.ADMIN.PASSWORD;
				const name = common.USER.ADMIN.NAME;
				const roleName = common.ROLE.ADMIN.NAME;

				const options: common.OptionsCreateUser = {
					token,
					email,
					password,
					name,
					roleName,
				};

				// Action
				await common.CreateUser(api, options);

				const response = await request(api.url)
					.get(`/users`)
					.query({
						filter: { email: { _eq: email } },
						fields: ['id', 'email', 'token', 'role'],
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						email: email,
						token: expect.any(String),
						role: expect.any(String),
					},
				]);
			});
		});

		describe('Creates default app access user', () => {
			test('REST', async ({ api }) => {
				// Setup
				const token = common.USER.APP_ACCESS.TOKEN;
				const email = common.USER.APP_ACCESS.EMAIL;
				const password = common.USER.APP_ACCESS.PASSWORD;
				const name = common.USER.APP_ACCESS.NAME;
				const roleName = common.ROLE.APP_ACCESS.NAME;

				const options: common.OptionsCreateUser = {
					token,
					email,
					password,
					name,
					roleName,
				};

				// Action
				await common.CreateUser(api, options);

				const response = await request(api.url)
					.get(`/users`)
					.query({
						filter: { email: { _eq: email } },
						fields: ['id', 'email', 'token', 'role'],
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						email: email,
						token: expect.any(String),
						role: expect.any(String),
					},
				]);
			});
		});

		describe('Creates default API only user', () => {
			test('REST', async ({ api }) => {
				// Setup
				const token = common.USER.API_ONLY.TOKEN;
				const email = common.USER.API_ONLY.EMAIL;
				const password = common.USER.API_ONLY.PASSWORD;
				const name = common.USER.API_ONLY.NAME;
				const roleName = common.ROLE.API_ONLY.NAME;

				const options: common.OptionsCreateUser = {
					token,
					email,
					password,
					name,
					roleName,
				};

				// Action
				await common.CreateUser(api, options);

				const response = await request(api.url)
					.get(`/users`)
					.query({
						filter: { email: { _eq: email } },
						fields: ['id', 'email', 'token', 'role'],
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						email: email,
						token: expect.any(String),
						role: expect.any(String),
					},
				]);
			});
		});

		describe('Creates default no-role user', () => {
			test('REST', async ({ api }) => {
				// Setup
				const token = common.USER.NO_ROLE.TOKEN;
				const email = common.USER.NO_ROLE.EMAIL;
				const password = common.USER.NO_ROLE.PASSWORD;
				const name = common.USER.NO_ROLE.NAME;

				const options: common.OptionsCreateUser = {
					token,
					email,
					password,
					name,
				};

				// Action
				await common.CreateUser(api, options);

				const response = await request(api.url)
					.get(`/users`)
					.query({
						filter: { email: { _eq: email } },
						fields: ['id', 'email', 'token', 'role'],
					})
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual([
					{
						id: expect.any(String),
						email: email,
						token: expect.any(String),
						role: null,
					},
				]);
			});
		});
	});

	describe('createCollection()', () => {
		describe('Creates a new collection', () => {
			test('REST', async ({ api }) => {
				// Setup
				const options: common.OptionsCreateCollection = {
					collection: collectionName,
				};

				const options2: common.OptionsCreateCollection = {
					collection: collectionNameM2O,
				};

				const options3: common.OptionsCreateCollection = {
					collection: collectionNameO2M,
				};

				// Action
				await common.CreateCollection(api, options);

				const response = await request(api.url)
					.get(`/collections/${collectionName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				await common.CreateCollection(api, options2);

				const response2 = await request(api.url)
					.get(`/collections/${collectionNameM2O}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				await common.CreateCollection(api, options3);

				const response3 = await request(api.url)
					.get(`/collections/${collectionNameO2M}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual({
					collection: collectionName,
					meta: expect.objectContaining({
						collection: collectionName,
					}),
					schema: expect.objectContaining({
						name: collectionName,
					}),
				});

				expect(response2.body.data).toEqual({
					collection: collectionNameM2O,
					meta: expect.objectContaining({
						collection: collectionNameM2O,
					}),
					schema: expect.objectContaining({
						name: collectionNameM2O,
					}),
				});

				expect(response3.body.data).toEqual({
					collection: collectionNameO2M,
					meta: expect.objectContaining({
						collection: collectionNameO2M,
					}),
					schema: expect.objectContaining({
						name: collectionNameO2M,
					}),
				});
			}, 30000);
		});
	});

	describe('createField()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await common.CreateCollection(api, { collection: collectionName });
		});

		describe('Creates a new field', () => {
			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'sample_field';
				const fieldType = 'string';

				const options: common.OptionsCreateField = {
					collection: collectionName,
					field: fieldName,
					type: fieldType,
				};

				// Action
				await common.CreateField(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionName}/${fieldName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual({
					collection: collectionName,
					field: fieldName,
					type: fieldType,
					meta: expect.anything(),
					schema: expect.anything(),
				});
			}, 30000);
		});
	});

	describe('createFieldM2O()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await common.CreateCollection(api, { collection: collectionName });
		});

		describe('Creates a new M2O field', () => {
			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'm2o_field';
				const primaryKeyType = 'integer';

				const collectionOptions: common.OptionsCreateCollection = {
					collection: collectionNameM2O,
					primaryKeyType,
				};

				await common.CreateCollection(api, collectionOptions);

				const options: common.OptionsCreateFieldM2O = {
					collection: collectionName,
					field: fieldName,
					otherCollection: collectionNameM2O,
					primaryKeyType: primaryKeyType,
				};

				// Action
				await common.CreateFieldM2O(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionName}/${fieldName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual({
					collection: collectionName,
					field: fieldName,
					type: primaryKeyType,
					meta: expect.objectContaining({
						special: expect.arrayContaining(['m2o']),
					}),
					schema: expect.anything(),
				});
			}, 30000);
		});
	});

	describe('createFieldO2M()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await common.CreateCollection(api, { collection: collectionName });
		});

		describe('Creates a new O2M field', () => {
			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'o2m_field';
				const otherFieldName = 'm2o_field';
				const primaryKeyType = 'integer';

				const collectionOptions: common.OptionsCreateCollection = {
					collection: collectionNameO2M,
					primaryKeyType,
				};

				await common.CreateCollection(api, collectionOptions);

				const options: common.OptionsCreateFieldO2M = {
					collection: collectionName,
					field: fieldName,
					otherField: otherFieldName,
					otherCollection: collectionNameO2M,
					primaryKeyType: primaryKeyType,
				};

				// Action
				await common.CreateFieldO2M(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionName}/${fieldName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual({
					collection: collectionName,
					field: fieldName,
					type: 'alias',
					meta: expect.anything(),
					schema: null,
				});
			}, 30000);
		});
	});

	describe('createItem()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await prepareSchema(api);
		});

		describe('Creates a new item', () => {
			test('REST', async ({ api }) => {
				// Setup
				const options: common.OptionsCreateItem = {
					collection: collectionName,
					item: {
						sample_field: 'sample_value',
					},
				};

				// Action
				const createdItem = await common.CreateItem(api, options);

				const response = await request(api.url)
					.get(`/items/${collectionName}/${createdItem.id}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual(
					expect.objectContaining({
						id: createdItem.id,
						sample_field: 'sample_value',
					})
				);
			}, 30000);
		});

		describe('Creates a new M2O item', () => {
			test('REST', async ({ api }) => {
				// Setup
				const options: common.OptionsCreateItem = {
					collection: collectionName,
					item: {
						sample_field: 'sample_value',
						m2o_field: {},
					},
				};

				// Action
				const createdItem = await common.CreateItem(api, options);

				const response = await request(api.url)
					.get(`/items/${collectionName}/${createdItem.id}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual(
					expect.objectContaining({
						id: createdItem.id,
						sample_field: 'sample_value',
						m2o_field: expect.any(Number),
					})
				);
			}, 30000);
		});

		describe('Creates a new O2M item', () => {
			test('REST', async ({ api }) => {
				// Setup
				const options: common.OptionsCreateItem = {
					collection: collectionName,
					item: {
						sample_field: 'sample_value',
						o2m_field: {
							create: [{}],
							update: [],
							delete: [],
						},
					},
				};

				// Action
				const createdItem = await common.CreateItem(api, options);

				const response = await request(api.url)
					.get(`/items/${collectionName}/${createdItem.id}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				expect(response.body.data).toEqual(
					expect.objectContaining({
						id: createdItem.id,
						sample_field: 'sample_value',
						o2m_field: [expect.any(Number)],
					})
				);
			}, 30000);
		});
	});

	describe('deleteField()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await prepareSchema(api);
			await prepareItems(api);
		});

		describe('Deletes an O2M field', () => {
			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'o2m_field';

				const options: common.OptionsDeleteField = {
					collection: collectionName,
					field: fieldName,
				};

				// Action
				await common.DeleteField(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				for (const child of response.body.data) {
					expect(child.field).not.toEqual(fieldName);
				}
			}, 30000);
		});

		describe('Deletes other M2O field', () => {
			beforeEach<{ api: Api }>(async ({ api }) => {
				await removePreviousFields(api, 1);
			});

			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'm2o_field';

				const options: common.OptionsDeleteField = {
					collection: collectionNameO2M,
					field: fieldName,
				};

				// Action
				await common.DeleteField(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionNameO2M}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				for (const child of response.body.data) {
					expect(child.field).not.toEqual(fieldName);
				}
			}, 30000);
		});

		describe('Deletes an M2O field', () => {
			beforeEach<{ api: Api }>(async ({ api }) => {
				await removePreviousFields(api, 2);
			});

			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'm2o_field';

				const options: common.OptionsDeleteField = {
					collection: collectionName,
					field: fieldName,
				};

				// Action
				await common.DeleteField(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				for (const child of response.body.data) {
					expect(child.field).not.toEqual(fieldName);
				}
			}, 30000);
		});

		describe('Deletes a field', () => {
			beforeEach<{ api: Api }>(async ({ api }) => {
				await removePreviousFields(api, 3);
			});

			test('REST', async ({ api }) => {
				// Setup
				const fieldName = 'sample_field';

				const options: common.OptionsDeleteField = {
					collection: collectionName,
					field: fieldName,
				};

				// Action
				await common.DeleteField(api, options);

				const response = await request(api.url)
					.get(`/fields/${collectionName}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				for (const child of response.body.data) {
					expect(child.field).not.toEqual(fieldName);
				}
			}, 30000);
		});
	});

	describe('deleteCollection()', () => {
		beforeEach<{ api: Api }>(async ({ api }) => {
			await prepareSchema(api);
			await prepareItems(api);
			await removePreviousFields(api, 4);
		});

		describe('Deletes a collection', () => {
			test('REST', async ({ api }) => {
				// Setup
				const options: common.OptionsDeleteCollection = {
					collection: collectionName,
				};

				// Action
				await common.DeleteCollection(api, options);

				const response = await request(api.url)
					.get(`/collections`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);

				// Assert
				for (const child of response.body.data) {
					expect(child.collection).not.toEqual(collectionName);
				}
			}, 30000);
		});
	});

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
