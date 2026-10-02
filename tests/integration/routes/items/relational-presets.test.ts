import { setupRequest } from '../../fixtures/request';
import { describe, expect, inject } from 'vitest';
import { apiTest } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateField, CreateFieldO2M } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const vendor = inject('integration').vendor;
const parentCollection = 'test_items_relational_presets_parent';
const childCollection = 'test_items_relational_presets_child';
const presetUserToken = 'RelationalPresetTestToken';

const test = apiTest.extend<{ schemaState: Prerequisite<void>; schemaReady: void }>({
	schemaState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;
			let roleId: string | undefined;
			let userId: string | undefined;

			await capturePrerequisite<void>(
				async (ready) => {
					try {
						await CreateCollection(api, { collection: parentCollection });
						await CreateCollection(api, { collection: childCollection });
						await CreateField(api, { collection: parentCollection, field: 'name', type: 'string' });
						await CreateField(api, { collection: childCollection, field: 'name', type: 'string' });

						await CreateFieldO2M(api, {
							collection: parentCollection,
							field: 'children',
							otherCollection: childCollection,
							otherField: 'parent_id',
							primaryKeyType: 'integer',
						});

						const role = await setupRequest(api.url)
							.post('/roles')
							.send({ name: 'Relational Preset Test Role', admin_access: false, app_access: true })
							.set('Authorization', `Bearer ${api.adminToken}`)
							.expect(200);

						roleId = role.body.data.id;

						const user = await setupRequest(api.url)
							.post('/users')
							.send({
								email: `relational-preset-${vendor}@tests.com`,
								password: 'RelationalPresetPassword',
								token: presetUserToken,
								role: roleId,
								status: 'active',
							})
							.set('Authorization', `Bearer ${api.adminToken}`)
							.expect(200);

						userId = user.body.data.id;

						await setupRequest(api.url)
							.post('/permissions')
							.send({
								role: roleId,
								collection: parentCollection,
								action: 'create',
								fields: ['*'],
								presets: { children: { create: [{ name: 'Preset child' }] } },
							})
							.set('Authorization', `Bearer ${api.adminToken}`)
							.expect(200);

						await setupRequest(api.url)
							.post('/permissions')
							.send({ role: roleId, collection: parentCollection, action: 'read', fields: ['*'] })
							.set('Authorization', `Bearer ${api.adminToken}`)
							.expect(200);

						await setupRequest(api.url)
							.post('/permissions')
							.send({ role: roleId, collection: childCollection, action: 'create', fields: ['*'] })
							.set('Authorization', `Bearer ${api.adminToken}`)
							.expect(200);

						await ready();
					} finally {
						if (api.available()) {
							for (const resource of [
								`/collections/${childCollection}`,
								`/collections/${parentCollection}`,
								...(userId ? [`/users/${userId}`] : []),
								...(roleId ? [`/roles/${roleId}`] : []),
							]) {
								try {
									await setupRequest(api.url).delete(resource).auth(api.adminToken, { type: 'bearer' }).expect(204);
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
		{ scope: 'file' },
	],
	schemaReady: [
		async ({ api, schemaState, task, skip }, use) => {
			void api;
			requirePrerequisite(schemaState, 'collection, relation and role prerequisites', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

describe('Relational field presets on item create', () => {
	test('applies a relational O2M preset to nested children on create', async ({ api }) => {
		const created = await request(api.url)
			.post(`/items/${parentCollection}`)
			.send({ name: 'Parent created without children in the payload' })
			.set('Authorization', `Bearer ${presetUserToken}`);

		expect(created.statusCode).toBe(200);

		const parentId = created.body.data.id;

		const readBack = await request(api.url)
			.get(`/items/${parentCollection}/${parentId}`)
			.query({ fields: '*,children.*' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.children).toHaveLength(1);
		expect(readBack.body.data.children[0].name).toBe('Preset child');
		expect(readBack.body.data.children[0].parent_id).toBe(parentId);
	});
});
