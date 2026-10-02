import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import {
	CreateCollection,
	CreateField,
	CreateFieldM2O,
	CreateFieldO2M,
	CreateRole,
	CreateUser,
	DeleteCollection,
	PRIMARY_KEY_TYPES,
} from '../../common/functions';

export const collectionFirst = 'test_ws_realtime_first';
export const collectionScoped = 'test_ws_realtime_scoped';
export const collectionChild = 'test_ws_realtime_child';

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

async function createPermission(api: Api, role: string, collection: string, filter: Record<string, any>) {
	const response = await setupRequest(api.url)
		.post('/permissions')
		.send({ role, collection, action: 'read', fields: ['*'], permissions: filter })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
}

async function deleteExistingUser(api: Api, email: string) {
	const existing = await setupRequest(api.url)
		.get('/users')
		.query({ filter: { email: { _eq: email } }, fields: ['id'] })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(existing.statusCode).toBe(200);
	expect(Array.isArray(existing.body.data)).toBe(true);

	for (const user of existing.body.data) {
		const response = await setupRequest(api.url)
			.delete(`/users/${user.id}`)
			.set('Authorization', `Bearer ${api.adminToken}`)
			.expect(204);

		expect(response.statusCode).toBe(204);
	}
}

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		const localCollection = `${collectionFirst}_${pkType}`;

		await DeleteCollection(api, { collection: localCollection });

		const created = await CreateCollection(api, { collection: localCollection, primaryKeyType: pkType });
		expect(created?.collection).toBe(localCollection);

		const nameField = await CreateField(api, { collection: localCollection, field: 'name', type: 'string' });
		expect(nameField?.field).toBe('name');
	}

	await DeleteCollection(api, { collection: collectionChild });
	await DeleteCollection(api, { collection: collectionScoped });

	const scoped = await CreateCollection(api, { collection: collectionScoped, primaryKeyType: 'integer' });
	expect(scoped?.collection).toBe(collectionScoped);

	const scopedName = await CreateField(api, { collection: collectionScoped, field: 'name', type: 'string' });
	expect(scopedName?.field).toBe('name');

	const scopedTenant = await CreateField(api, { collection: collectionScoped, field: 'tenant', type: 'string' });
	expect(scopedTenant?.field).toBe('tenant');

	const scopedOwner = await CreateFieldM2O(api, {
		collection: collectionScoped,
		field: 'owner',
		primaryKeyType: 'uuid',
		otherCollection: 'directus_users',
	});

	expect(scopedOwner?.field?.field).toBe('owner');
	expect(scopedOwner?.relation?.related_collection).toBe('directus_users');

	const child = await CreateCollection(api, { collection: collectionChild, primaryKeyType: 'integer' });
	expect(child?.collection).toBe(collectionChild);

	const children = await CreateFieldO2M(api, {
		collection: collectionScoped,
		field: 'children',
		otherCollection: collectionChild,
		otherField: 'parent',
	});

	expect(children?.field?.field).toBe('children');
	expect(children?.otherField?.field).toBe('parent');
	expect(children?.relation?.related_collection).toBe(collectionScoped);

	const roleId: Record<string, string> = {};

	for (const spec of Object.values(realtimeUsers)) {
		const role = await CreateRole(api, {
			name: spec.role,
			appAccessEnabled: false,
			adminAccessEnabled: false,
		});

		expect(role?.id).toBeDefined();
		roleId[spec.role] = role.id;

		await deleteExistingUser(api, spec.email);

		const user = await CreateUser(api, {
			token: spec.token,
			email: spec.email,
			roleName: spec.role,
		});

		expect(user?.id).toBeDefined();
	}

	await createPermission(api, roleId[realtimeUsers.tenantA.role]!, collectionScoped, {
		tenant: { _eq: TENANT_A },
	});

	await createPermission(api, roleId[realtimeUsers.tenantB.role]!, collectionScoped, {
		tenant: { _eq: TENANT_B },
	});

	await createPermission(api, roleId[realtimeUsers.readerAll.role]!, collectionScoped, {});

	await createPermission(api, roleId[realtimeUsers.owner.role]!, collectionScoped, {
		owner: { _eq: '$CURRENT_USER' },
	});
};
