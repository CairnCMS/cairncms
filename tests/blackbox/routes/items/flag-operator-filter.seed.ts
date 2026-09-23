import vendors from '@common/get-dbs-to-test';
import {
	CreateCollection,
	CreateField,
	CreateItem,
	CreateRole,
	CreateUser,
	DeleteCollection,
	USER,
} from '@common/index';
import { getUrl } from '@common/config';
import request from 'supertest';

export const collection = 'test_items_flag_operator_filter';

export const TENANT_A = 'A';
export const TENANT_B = 'B';

export const restrictedUser = {
	role: 'flag_filter_restricted',
	email: 'flag-filter-restricted@tests.com',
	token: 'FlagFilterRestrictedToken',
} as const;

async function createReadPermission(vendor: string, role: string, filter: Record<string, any>) {
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
			await DeleteCollection(vendor, { collection });

			const created = await CreateCollection(vendor, { collection, primaryKeyType: 'integer' });
			expect(created?.collection).toBe(collection);

			const labelField = await CreateField(vendor, { collection, field: 'label', type: 'string' });
			expect(labelField?.field).toBe('label');

			const tenantField = await CreateField(vendor, { collection, field: 'tenant', type: 'string' });
			expect(tenantField?.field).toBe('tenant');

			const role = await CreateRole(vendor, {
				name: restrictedUser.role,
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			expect(role?.id).toBeDefined();

			await deleteExistingUser(vendor, restrictedUser.email);

			const user = await CreateUser(vendor, {
				token: restrictedUser.token,
				email: restrictedUser.email,
				roleName: restrictedUser.role,
			});

			expect(user?.id).toBeDefined();

			await createReadPermission(vendor, role.id, {
				_and: [{ tenant: { _eq: TENANT_A } }, { label: { _null: false } }],
			});
		},
		300000
	);
};

export const seedDBValues = async () => {
	let isSeeded = true;

	await Promise.all(
		vendors.map(async (vendor) => {
			const items = [
				{ tenant: TENANT_A, label: 'has-label' },
				{ tenant: TENANT_A, label: null },
				{ tenant: TENANT_B, label: 'has-label' },
			];

			for (const item of items) {
				const created = await CreateItem(vendor, { collection, item });
				expect(created?.id).toBeDefined();
			}
		})
	)
		.then(() => {
			isSeeded = true;
		})
		.catch(() => {
			isSeeded = false;
		});

	return isSeeded;
};
