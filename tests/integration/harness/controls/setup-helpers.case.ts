import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
	CreateRole,
	CreateCollection,
	CreateField,
	CreateRelation,
	CreateFieldM2O,
	CreateFieldO2M,
} from '../../fixtures/schema';
import { CreateUser } from '../../common/functions';
import { CreateUser as CreateSeededUser, UpdateItem } from '../../fixtures/seeded';
import { CreateItem, setupGraphQL } from '../../fixtures/request';
import { ReadItem } from '../../fixtures/data';
import type { Api } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const secret = 'fixture-only-secret-67241';

const helpers: Array<[string, string, (api: Api) => Promise<unknown>]> = [
	['role', '/roles', (api) => CreateRole(api, { name: 'Role', appAccessEnabled: false, adminAccessEnabled: false })],
	['collection', '/collections', (api) => CreateCollection(api, { collection: 'example' })],
	['field', '/fields/example', (api) => CreateField(api, { collection: 'example', field: 'parent', type: 'integer' })],
	[
		'relation',
		'/relations',
		(api) => CreateRelation(api, { collection: 'example', field: 'parent', related_collection: 'parent' }),
	],
	[
		'M2O',
		'/relations',
		(api) => CreateFieldM2O(api, { collection: 'example', field: 'parent', otherCollection: 'parent' }),
	],
	[
		'O2M',
		'/relations',
		(api) =>
			CreateFieldO2M(api, {
				collection: 'parent',
				field: 'children',
				otherCollection: 'example',
				otherField: 'parent',
			}),
	],
	['user', '/users', (api) => CreateUser(api, { email: 'fixture@example.test', token: secret, password: secret })],
	[
		'seeded user',
		'/users',
		(api) => CreateSeededUser(api, { email: 'fixture@example.test', token: secret, roleName: 'Role' }),
	],
	['item', '/items/example', (api) => CreateItem(api, { collection: 'example', item: { title: 'Fixture' } })],
	['read item', '/items/example', (api) => ReadItem(api, { collection: 'example' })],
	[
		'update item',
		'/items/example/id',
		(api) => UpdateItem(api, { collection: 'example', id: 'id', item: { title: 'Fixture' } }),
	],
	[
		'GraphQL',
		'/graphql',
		(api) =>
			setupGraphQL(api.url, false, api.adminToken, {
				mutation: { create_example_item: { __args: { data: { title: 'Fixture' } }, id: true } },
			}),
	],
];

for (const [name, endpoint, invoke] of helpers)
	for (const mode of ['valid', 'rejected-400', 'rejected-500', 'missing-data', 'empty-data'])
		test(`${name} helper handles ${mode}`, async () => {
			const server = createServer(async (request, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(chunk);
				const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
				const path = request.url!.split('?')[0];
				response.setHeader('content-type', 'application/json');

				if (path === endpoint && mode.startsWith('rejected')) {
					response.statusCode = Number(mode.slice(-3));

					response.end(
						JSON.stringify({
							errors: [{ message: `SETUP_REJECTION_DETAIL ${secret}`, extensions: { code: 'INVALID_PAYLOAD' } }],
						})
					);
				} else if (path === endpoint && ['missing-data', 'empty-data'].includes(mode)) {
					response.end(mode === 'missing-data' ? '{}' : '{"data":{}}');
				} else {
					const row = { ...payload, id: 'fixture-id' };
					if (path.startsWith('/fields/')) row.collection = path.split('/')[2];

					response.end(
						JSON.stringify({
							data: request.method === 'GET' && path === '/roles' ? [{ id: 'role-id', name: 'Role' }] : row,
						})
					);
				}
			});

			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing HTTP control address');
			const api = { url: `http://127.0.0.1:${address.port}`, adminToken: secret } as Api;

			try {
				if (mode === 'valid') expect(await invoke(api)).toBeDefined();
				else {
					let caught: Error | undefined;

					try {
						await invoke(api);
					} catch (error) {
						caught = error as Error;
					}

					expect(caught, `${name} must reject ${mode}`).toBeInstanceOf(Error);
					expect(caught!.message).toContain('HTTP request failed');
					if (mode.startsWith('rejected')) expect(caught!.message).toContain(`SETUP_REJECTION_DETAIL ${secret}`);
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		});
