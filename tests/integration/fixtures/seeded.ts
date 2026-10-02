import { expect } from 'vitest';
import type { Api } from './environment';
import { createIdentityTest } from './identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';
import { setupRequest as request } from './request';
export * from './data';

type SeedOptions = {
	tables: string[];
	seedDBStructure: (api: Api) => Promise<void>;
	seedDBValues: (api: Api) => Promise<boolean>;
};

export const createSeededTest = (options: SeedOptions) =>
	createIdentityTest().extend<{
		schemaState: Prerequisite<void>;
		isSeeded: boolean;
	}>({
		schemaState: [
			async ({ apiState, identityState, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				if (!identityState.ok) return use(identityState);

				await capturePrerequisite<void>(
					async (ready) => {
						await options.seedDBStructure(apiState.value);
						await ready();
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		isSeeded: [
			async ({ api, identities, schemaState, task, skip }, use) => {
				void identities;
				requirePrerequisite(schemaState, 'collection schema', { task, skip });
				// Seed through the API so hooks and audit side effects accompany each fresh row set.
				for (const table of [...options.tables].reverse()) await api.database(table).delete();
				const seeded = await options.seedDBValues(api);
				expect(seeded, 'Required API data setup completed').toBe(true);
				await use(seeded);
			},
			{ auto: true },
		],
	});

export async function UpdateItem(api: Api, options: { collection: string; id?: string | number; item: any }) {
	const response = await request(api.url)
		.patch(`/items/${options.collection}/${options.id === undefined ? '' : options.id}`)
		.auth(api.adminToken, { type: 'bearer' })
		.send(options.item)
		.expect(200);

	return response.body.data;
}

export async function CreateUser(api: Api, options: { token: string; email: string; roleName: string }) {
	const roles = await request(api.url)
		.get('/roles')
		.query({ filter: { name: { _eq: options.roleName } }, fields: ['id', 'name'] })
		.auth(api.adminToken, { type: 'bearer' })
		.expect(200);

	if (roles.body.data.length !== 1) throw new Error(`Expected one role named ${options.roleName}`);

	const response = await request(api.url)
		.post('/users')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ token: options.token, email: options.email, role: roles.body.data[0].id })
		.expect(200);

	return response.body.data;
}
