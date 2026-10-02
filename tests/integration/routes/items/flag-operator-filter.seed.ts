import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import { CreateCollection, CreateField, CreateItem, CreateRole, CreateUser } from '../../fixtures/seeded';

import request from '../../fixtures/request';

export const collection = 'test_items_flag_operator_filter';

export const TENANT_A = 'A';
export const TENANT_B = 'B';

export const restrictedUser = {
	role: 'flag_filter_restricted',
	email: 'flag-filter-restricted@tests.com',
	token: 'FlagFilterRestrictedToken',
} as const;

async function createReadPermission(api: Api, role: string, filter: Record<string, any>) {
	const response = await setupRequest(api.url)
		.post('/permissions')
		.send({ role, collection, action: 'read', fields: ['*'], permissions: filter })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
}

async function deleteExistingUser(api: Api, email: string) {
	const existing = await request(api.url)
		.get('/users')
		.query({ filter: { email: { _eq: email } }, fields: ['id'] })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(existing.statusCode).toBe(200);

	for (const user of existing.body.data) {
		const response = await request(api.url)
			.delete(`/users/${user.id}`)
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(response.statusCode).toBe(204);
	}
}

export const seedDBStructure = async (api: Api) => {
	const created = await CreateCollection(api, { collection, primaryKeyType: 'integer' });
	expect(created?.collection).toBe(collection);

	const labelField = await CreateField(api, { collection, field: 'label', type: 'string' });
	expect(labelField?.field).toBe('label');

	const tenantField = await CreateField(api, { collection, field: 'tenant', type: 'string' });
	expect(tenantField?.field).toBe('tenant');

	const role = await CreateRole(api, {
		name: restrictedUser.role,
		appAccessEnabled: false,
		adminAccessEnabled: false,
	});

	expect(role?.id).toBeDefined();

	await deleteExistingUser(api, restrictedUser.email);

	const user = await CreateUser(api, {
		token: restrictedUser.token,
		email: restrictedUser.email,
		roleName: restrictedUser.role,
	});

	expect(user?.id).toBeDefined();

	await createReadPermission(api, role.id, {
		_and: [{ tenant: { _eq: TENANT_A } }, { label: { _null: false } }],
	});
};

export const seedDBValues = async (api: Api) => {
	const items = [
		{ tenant: TENANT_A, label: 'has-label' },
		{ tenant: TENANT_A, label: null },
		{ tenant: TENANT_B, label: 'has-label' },
	];

	for (const item of items) {
		const created = await CreateItem(api, { collection, item });
		expect(created?.id).toBeDefined();
	}

	return true;
};
