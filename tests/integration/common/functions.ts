export * from '../fixtures/data';
import type { Api } from '../fixtures/environment';
import request, { setupRequest, assertSetupResponse } from '../fixtures/request';

export type OptionsCreateItem = { collection: string; item: any };
export const ROLE = {
	ADMIN: { NAME: 'Admin Role' },
	APP_ACCESS: { NAME: 'App Access Role' },
	API_ONLY: { NAME: 'API Only Role' },
};
export type OptionsCreateUser = {
	token: string;
	email: string;
	password?: string;
	name?: string;
	role?: string;
	// Automatically removed params
	roleName?: string; // to generate role
};

export async function CreateUser(api: Api, options: Partial<OptionsCreateUser>) {
	// Validate options
	if (!options.token) {
		throw new Error('Missing required field: token');
	}

	if (!options.email) {
		throw new Error('Missing required field: email');
	}

	if (options.roleName) {
		const roleResponse = await setupRequest(api.url)
			.get(`/roles`)
			.query({
				filter: { name: { _eq: options.roleName } },
				fields: ['id', 'name'],
			})
			.set('Authorization', `Bearer ${api.adminToken}`)
			.expect(200);

		if (roleResponse.body.data.length === 0) {
			throw new Error(`Role ${options.roleName} does not exist`);
		}

		options.role = roleResponse.body.data[0].id;
		delete options.roleName;
	}

	// Action
	const response = await setupRequest(api.url)
		.post(`/users`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send(options)
		.expect(200);

	if (typeof response.body.data?.id !== 'string' || !response.body.data.id)
		throw new Error('User fixture creation returned no identity');

	return response.body.data;
}

export type OptionsDeleteCollection = {
	collection: string;
};

export async function DeleteCollection(api: Api, options: OptionsDeleteCollection) {
	// Action
	const response = await request(api.url)
		.delete(`/collections/${options.collection}`)
		.set('Authorization', `Bearer ${api.adminToken}`);

	// An absent schema resource returns 403 or 404 to an administrator.
	if (![403, 404].includes(response.status)) assertSetupResponse(response);
	return response.body;
}

export type OptionsDeleteField = {
	collection: string;
	field: string;
};

export async function DeleteField(api: Api, options: OptionsDeleteField) {
	// Action
	const response = await request(api.url)
		.delete(`/fields/${options.collection}/${options.field}`)
		.set('Authorization', `Bearer ${api.adminToken}`);

	// An absent schema resource returns 403 or 404 to an administrator.
	if (![403, 404].includes(response.status)) assertSetupResponse(response);
	return response.body;
}
