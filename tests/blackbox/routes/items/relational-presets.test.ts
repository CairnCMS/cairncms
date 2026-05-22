import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import request from 'supertest';

// The preset path is only exercised under a non-admin accountability (admin bypasses
// the permission system), so this test creates its own non-admin role rather than
// reusing the admin-capable TESTS_FLOW role.

const parentCollection = 'test_items_relational_presets_parent';
const childCollection = 'test_items_relational_presets_child';
const adminToken = common.USER.ADMIN.TOKEN;
const presetUserToken = 'RelationalPresetTestToken';

describe('Relational field presets on item create', () => {
	const roleId = {} as Record<string, string>;
	const userId = {} as Record<string, string>;

	beforeAll(async () => {
		for (const vendor of vendors) {
			await common.CreateCollection(vendor, { collection: parentCollection });
			await common.CreateCollection(vendor, { collection: childCollection });
			await common.CreateField(vendor, { collection: parentCollection, field: 'name', type: 'string' });
			await common.CreateField(vendor, { collection: childCollection, field: 'name', type: 'string' });

			await common.CreateFieldO2M(vendor, {
				collection: parentCollection,
				field: 'children',
				otherCollection: childCollection,
				otherField: 'parent_id',
				primaryKeyType: 'integer',
			});

			const role = await request(getUrl(vendor))
				.post('/roles')
				.send({ name: 'Relational Preset Test Role', admin_access: false, app_access: true })
				.set('Authorization', `Bearer ${adminToken}`);

			roleId[vendor] = role.body.data.id;

			const user = await request(getUrl(vendor))
				.post('/users')
				.send({
					email: `relational-preset-${vendor}@tests.com`,
					password: 'RelationalPresetPassword',
					token: presetUserToken,
					role: roleId[vendor],
					status: 'active',
				})
				.set('Authorization', `Bearer ${adminToken}`);

			userId[vendor] = user.body.data.id;

			await request(getUrl(vendor))
				.post('/permissions')
				.send({
					role: roleId[vendor],
					collection: parentCollection,
					action: 'create',
					fields: ['*'],
					presets: { children: { create: [{ name: 'Preset child' }] } },
				})
				.set('Authorization', `Bearer ${adminToken}`);

			// Read permission so the create response carries the new primary key.
			await request(getUrl(vendor))
				.post('/permissions')
				.send({ role: roleId[vendor], collection: parentCollection, action: 'read', fields: ['*'] })
				.set('Authorization', `Bearer ${adminToken}`);

			// `fields: ['*']` so the nested create can write the parent foreign key on the child.
			await request(getUrl(vendor))
				.post('/permissions')
				.send({ role: roleId[vendor], collection: childCollection, action: 'create', fields: ['*'] })
				.set('Authorization', `Bearer ${adminToken}`);
		}
	}, 300000);

	afterAll(async () => {
		for (const vendor of vendors) {
			await request(getUrl(vendor))
				.delete(`/collections/${childCollection}`)
				.set('Authorization', `Bearer ${adminToken}`);

			await request(getUrl(vendor))
				.delete(`/collections/${parentCollection}`)
				.set('Authorization', `Bearer ${adminToken}`);

			// Delete the user before the role so it is never left orphaned with role = null.
			if (userId[vendor]) {
				await request(getUrl(vendor))
					.delete(`/users/${userId[vendor]}`)
					.set('Authorization', `Bearer ${adminToken}`);
			}

			if (roleId[vendor]) {
				await request(getUrl(vendor))
					.delete(`/roles/${roleId[vendor]}`)
					.set('Authorization', `Bearer ${adminToken}`);
			}
		}
	});

	it.each(vendors)('%s applies a relational O2M preset to nested children on create', async (vendor) => {
		const created = await request(getUrl(vendor))
			.post(`/items/${parentCollection}`)
			.send({ name: 'Parent created without children in the payload' })
			.set('Authorization', `Bearer ${presetUserToken}`);

		expect(created.statusCode).toBe(200);

		const parentId = created.body.data.id;

		const readBack = await request(getUrl(vendor))
			.get(`/items/${parentCollection}/${parentId}`)
			.query({ fields: '*,children.*' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.children).toHaveLength(1);
		expect(readBack.body.data.children[0].name).toBe('Preset child');
		expect(readBack.body.data.children[0].parent_id).toBe(parentId);
	});
});
