import vendors from '@common/get-dbs-to-test';
import {
	CreateCollection,
	CreateField,
	CreateFieldM2O,
	CreateRole,
	CreateUser,
	DeleteCollection,
	PRIMARY_KEY_TYPES,
	USER,
} from '@common/index';
import { getUrl } from '@common/config';
import request from 'supertest';

export const collectionFirst = 'test_ws_realtime_first';
export const collectionScoped = 'test_ws_realtime_scoped';

export type First = {
	id?: number | string;
	name?: string;
};

export const TENANT_A = 'A';
export const TENANT_B = 'B';

export const realtimeUsers = {
	tenantA: { role: 'ws_tenant_a', email: 'ws-tenant-a@realtime.tests', token: 'WsTenantAToken' },
	tenantB: { role: 'ws_tenant_b', email: 'ws-tenant-b@realtime.tests', token: 'WsTenantBToken' },
	readerAll: { role: 'ws_reader_all', email: 'ws-reader-all@realtime.tests', token: 'WsReaderAllToken' },
	owner: { role: 'ws_owner', email: 'ws-owner@realtime.tests', token: 'WsOwnerToken' },
} as const;

async function createPermission(vendor: string, role: string, collection: string, filter: Record<string, any>) {
	const response = await request(getUrl(vendor))
		.post('/permissions')
		.send({ role, collection, action: 'read', fields: ['*'], permissions: filter })
		.set('Authorization', `Bearer ${USER.TESTS_FLOW.TOKEN}`);

	expect(response.statusCode).toBe(200);
}

async function deleteExistingUser(vendor: string, email: string) {
	const existing = await request(getUrl(vendor))
		.get('/users')
		.query({ filter: { email: { _eq: email } }, fields: ['id'] })
		.set('Authorization', `Bearer ${USER.TESTS_FLOW.TOKEN}`);

	expect(existing.statusCode).toBe(200);
	expect(Array.isArray(existing.body.data)).toBe(true);

	for (const user of existing.body.data) {
		const response = await request(getUrl(vendor))
			.delete(`/users/${user.id}`)
			.set('Authorization', `Bearer ${USER.TESTS_FLOW.TOKEN}`);

		expect(response.statusCode).toBe(204);
	}
}

export const seedDBStructure = () => {
	it.each(vendors)(
		'%s',
		async (vendor) => {
			for (const pkType of PRIMARY_KEY_TYPES) {
				const localCollection = `${collectionFirst}_${pkType}`;

				await DeleteCollection(vendor, { collection: localCollection });

				const created = await CreateCollection(vendor, { collection: localCollection, primaryKeyType: pkType });
				expect(created.collection).toBe(localCollection);

				const nameField = await CreateField(vendor, { collection: localCollection, field: 'name', type: 'string' });
				expect(nameField.field).toBe('name');
			}

			await DeleteCollection(vendor, { collection: collectionScoped });

			const scoped = await CreateCollection(vendor, { collection: collectionScoped, primaryKeyType: 'integer' });
			expect(scoped.collection).toBe(collectionScoped);

			const scopedName = await CreateField(vendor, { collection: collectionScoped, field: 'name', type: 'string' });
			expect(scopedName.field).toBe('name');

			const scopedTenant = await CreateField(vendor, { collection: collectionScoped, field: 'tenant', type: 'string' });
			expect(scopedTenant.field).toBe('tenant');

			const scopedOwner = await CreateFieldM2O(vendor, {
				collection: collectionScoped,
				field: 'owner',
				primaryKeyType: 'uuid',
				otherCollection: 'directus_users',
			});

			expect(scopedOwner.field.field).toBe('owner');
			expect(scopedOwner.relation.related_collection).toBe('directus_users');

			const roleId: Record<string, string> = {};

			for (const spec of Object.values(realtimeUsers)) {
				const role = await CreateRole(vendor, {
					name: spec.role,
					appAccessEnabled: false,
					adminAccessEnabled: false,
				});

				expect(role.id).toBeDefined();
				roleId[spec.role] = role.id;

				await deleteExistingUser(vendor, spec.email);

				const user = await CreateUser(vendor, {
					token: spec.token,
					email: spec.email,
					roleName: spec.role,
				});

				expect(user.id).toBeDefined();
			}

			await createPermission(vendor, roleId[realtimeUsers.tenantA.role]!, collectionScoped, {
				tenant: { _eq: TENANT_A },
			});

			await createPermission(vendor, roleId[realtimeUsers.tenantB.role]!, collectionScoped, {
				tenant: { _eq: TENANT_B },
			});

			await createPermission(vendor, roleId[realtimeUsers.readerAll.role]!, collectionScoped, {});

			await createPermission(vendor, roleId[realtimeUsers.owner.role]!, collectionScoped, {
				owner: { _eq: '$CURRENT_USER' },
			});
		},
		300000
	);
};
