import { randomUUID } from 'node:crypto';
import { describe, expect, inject } from 'vitest';
import { createApiTest, type Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { requestGraphQL, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateField, CreateFieldO2M } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { sleep } from '../../utils/sleep';
import { createWebSocketConn } from '../realtime/transport';

initializeFixtures();

const vendor = inject('integration').vendor;
const runId = randomUUID().slice(0, 8);
const itemsCollection = `test_mqe_items_${runId}`;
const parentCollection = `test_mqe_parent_${runId}`;
const childCollection = `test_mqe_child_${runId}`;

const tenantReaderToken = `MqeTenantReader_${runId}`;
const userEditorToken = `MqeUserEditor_${runId}`;
const childWriteOnlyToken = `MqeChildWriteOnly_${runId}`;
const childPartialReadToken = `MqeChildPartialRead_${runId}`;
const childReaderToken = `MqeChildReader_${runId}`;

const userDomain = `@mqe-${runId}.test`;
const visibleUserMarker = `mqe-visible-${runId}`;

type Register = (fn: () => Promise<void>) => void;

async function createRoleUser(api: Api, name: string, token: string, register: Register): Promise<string> {
	const role = await setupRequest(api.url)
		.post('/roles')
		.send({ name, admin_access: false, app_access: false })
		.set('Authorization', `Bearer ${api.adminToken}`);

	const roleId = role.body.data.id as string;

	register(async () => {
		await request(api.url).delete(`/roles/${roleId}`).set('Authorization', `Bearer ${api.adminToken}`);
	});

	const user = await setupRequest(api.url)
		.post('/users')
		.send({ email: `${token.toLowerCase()}-${vendor}@tests.com`, password: 'MqePassword1', token, role: roleId })
		.set('Authorization', `Bearer ${api.adminToken}`);

	const userId = user.body.data.id as string;

	register(async () => {
		await request(api.url).delete(`/users/${userId}`).set('Authorization', `Bearer ${api.adminToken}`);
	});

	return roleId;
}

async function grant(
	api: Api,
	role: string,
	collection: string,
	action: string,
	fields: readonly string[],
	permissions: Record<string, any> = {}
) {
	await setupRequest(api.url)
		.post('/permissions')
		.send({ role, collection, action, fields, permissions })
		.set('Authorization', `Bearer ${api.adminToken}`);
}

async function createItem(api: Api, collection: string, body: Record<string, any>) {
	const response = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.send(body)
		.set('Authorization', `Bearer ${api.adminToken}`);

	return response.body.data.id as number;
}

async function createUser(api: Api, email: string, title: string) {
	const response = await setupRequest(api.url)
		.post('/users')
		.send({ email, password: 'MqePassword1', first_name: 'Original', title })
		.set('Authorization', `Bearer ${api.adminToken}`);

	return response.body.data.id as string;
}

type Fixture = { tenantReaderRole: string };

type Scenario = {
	items: Record<'a1' | 'a2' | 'b1', number>;
	parent: number;
	soloParent: number;
	children: Record<'visible' | 'hidden' | 'solo', number>;
	users: Record<'visible' | 'hidden', { id: string; email: string }>;
};

async function readRow(api: Api, collection: string, id: number | string, fields = '*') {
	const response = await request(api.url)
		.get(`/items/${collection}/${id}`)
		.query({ fields })
		.set('Authorization', `Bearer ${api.adminToken}`);

	return response.statusCode === 200 ? response.body.data : null;
}

const labels = async (api: Api, ids: number[]) =>
	Promise.all(ids.map(async (id) => (await readRow(api, itemsCollection, id, 'label'))?.label ?? null));

const childRow = (api: Api, id: number) => readRow(api, childCollection, id, 'name,parent_id');

const firstName = async (api: Api, id: string) =>
	(await api.database('directus_users').where({ id }).first('first_name'))?.first_name;

const test = createApiTest({
	env: {
		WEBSOCKETS_ENABLED: 'true',
		WEBSOCKETS_REST_ENABLED: 'true',
		WEBSOCKETS_REST_AUTH: 'handshake',
		WEBSOCKETS_REST_PATH: '/websocket',
	},
}).extend<{ schemaState: Prerequisite<Fixture>; fixture: Fixture; scenario: Scenario }>({
	schemaState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<Fixture>(
				async (ready) => {
					const cleanups: Array<() => Promise<void>> = [];
					const track = (fn: () => Promise<void>) => cleanups.push(fn);

					try {
						for (const collection of [itemsCollection, parentCollection, childCollection]) {
							await CreateCollection(api, { collection });

							track(async () => {
								await request(api.url)
									.delete(`/collections/${collection}`)
									.set('Authorization', `Bearer ${api.adminToken}`);
							});
						}

						for (const field of ['label', 'secret', 'tenant']) {
							await CreateField(api, { collection: itemsCollection, field, type: 'string' });
						}

						for (const collection of [parentCollection, childCollection]) {
							await CreateField(api, { collection, field: 'name', type: 'string' });
						}

						await CreateFieldO2M(api, {
							collection: parentCollection,
							field: 'children',
							otherCollection: childCollection,
							otherField: 'parent_id',
							primaryKeyType: 'integer',
							relationMeta: { one_deselect_action: 'nullify' },
						});

						const writable = { tenant: { _in: ['A', 'B'] } };

						const tenantReader = await createRoleUser(api, `MQE Tenant Reader ${runId}`, tenantReaderToken, track);

						await grant(api, tenantReader, itemsCollection, 'read', ['id', 'label', 'tenant'], {
							tenant: { _eq: 'A' },
						});

						await grant(api, tenantReader, itemsCollection, 'update', ['label', 'secret'], writable);
						await grant(api, tenantReader, itemsCollection, 'delete', ['*'], writable);

						const userEditor = await createRoleUser(api, `MQE User Editor ${runId}`, userEditorToken, track);

						await grant(api, userEditor, 'directus_users', 'read', ['id', 'email', 'first_name'], {
							email: { _contains: visibleUserMarker },
						});

						await grant(api, userEditor, 'directus_users', 'update', ['first_name'], {
							email: { _ends_with: userDomain },
						});

						const childWriteOnly = await createRoleUser(
							api,
							`MQE Child Write Only ${runId}`,
							childWriteOnlyToken,
							track
						);

						await grant(api, childWriteOnly, parentCollection, 'read', ['*']);
						await grant(api, childWriteOnly, parentCollection, 'update', ['*']);
						await grant(api, childWriteOnly, childCollection, 'update', ['*']);

						const partial = await createRoleUser(api, `MQE Child Partial ${runId}`, childPartialReadToken, track);
						await grant(api, partial, parentCollection, 'read', ['*']);
						await grant(api, partial, parentCollection, 'update', ['*']);
						await grant(api, partial, childCollection, 'read', ['*'], { name: { _neq: 'Hidden child' } });
						await grant(api, partial, childCollection, 'update', ['*']);

						const reader = await createRoleUser(api, `MQE Child Reader ${runId}`, childReaderToken, track);
						await grant(api, reader, parentCollection, 'read', ['*']);
						await grant(api, reader, parentCollection, 'update', ['*']);
						await grant(api, reader, childCollection, 'read', ['*']);
						await grant(api, reader, childCollection, 'update', ['*']);

						await ready({ tenantReaderRole: tenantReader });
					} finally {
						if (api.available())
							for (const cleanup of cleanups.reverse()) {
								try {
									await cleanup();
								} catch (error) {
									teardownFailures.push(error);
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
	fixture: async ({ schemaState, task, skip }, use) => {
		await use(requirePrerequisite(schemaState, 'entry point schema and permissions', { task, skip }));
	},
	scenario: [
		async ({ api, fixture, teardownFailures }, use) => {
			void fixture;

			for (const table of [itemsCollection, childCollection, parentCollection]) {
				await api.database(table).delete();
			}

			const item = (label: string, secret: string, tenant: string) =>
				createItem(api, itemsCollection, { label, secret, tenant });

			const parent = await createItem(api, parentCollection, { name: 'Parent' });
			const soloParent = await createItem(api, parentCollection, { name: 'Solo parent' });
			const marker = randomUUID().slice(0, 8);
			const visibleEmail = `${visibleUserMarker}-${marker}${userDomain}`;
			const hiddenEmail = `mqe-hidden-${marker}${userDomain}`;

			const scenario: Scenario = {
				items: {
					a1: await item('A one', 'alpha', 'A'),
					a2: await item('A two', 'beta', 'A'),
					b1: await item('B one', 'alpha', 'B'),
				},
				parent,
				soloParent,
				children: {
					visible: await createItem(api, childCollection, { name: 'Visible child', parent_id: parent }),
					hidden: await createItem(api, childCollection, { name: 'Hidden child', parent_id: parent }),
					solo: await createItem(api, childCollection, { name: 'Solo child', parent_id: soloParent }),
				},
				users: {
					visible: { id: await createUser(api, visibleEmail, 'Visible title'), email: visibleEmail },
					hidden: { id: await createUser(api, hiddenEmail, 'Hidden title'), email: hiddenEmail },
				},
			};

			try {
				await use(scenario);
			} finally {
				for (const user of Object.values(scenario.users)) {
					try {
						await request(api.url).delete(`/users/${user.id}`).set('Authorization', `Bearer ${api.adminToken}`);
					} catch (error) {
						teardownFailures.push(error);
					}
				}
			}
		},
		{ auto: true },
	],
});

async function realtime(api: Api, token: string, message: Record<string, any>) {
	const ws = createWebSocketConn(api.url, { auth: { access_token: token } });

	try {
		await ws.sendMessage({ type: 'items', uid: 'mutation', collection: itemsCollection, ...message });
		const frames = await ws.getMessages(1, { uid: 'mutation' });
		return frames![0]! as Record<string, any>;
	} finally {
		ws.conn.close();
	}
}

describe('Realtime query mutations select only readable records', () => {
	test('refuses an update or delete whose filter reads a hidden field', async ({ api, scenario }) => {
		for (const message of [
			{ action: 'update', query: { filter: { secret: { _eq: 'beta' } } }, data: { label: 'Probed' } },
			{ action: 'delete', query: { filter: { secret: { _eq: 'beta' } } } },
		]) {
			const frame = await realtime(api, tenantReaderToken, message);
			expect(frame).toMatchObject({ type: 'items', status: 'error', error: { code: 'FORBIDDEN' } });
		}

		expect(await labels(api, [scenario.items.a2])).toEqual(['A two']);
	});

	test('does not discover a writable record outside the read scope', async ({ api, scenario }) => {
		for (const message of [
			{ action: 'update', query: { filter: { label: { _eq: 'B one' } } }, data: { label: 'Changed' } },
			{ action: 'delete', query: { filter: { label: { _eq: 'B one' } } } },
		]) {
			const frame = await realtime(api, tenantReaderToken, message);
			expect(frame).toMatchObject({ type: 'items', data: [] });
			expect(frame).not.toHaveProperty('error');
		}

		expect(await labels(api, [scenario.items.b1])).toEqual(['B one']);
	});

	test('updates and deletes a readable, writable selection', async ({ api, scenario }) => {
		const { a1 } = scenario.items;

		const updated = await realtime(api, tenantReaderToken, {
			action: 'update',
			query: { filter: { id: { _eq: a1 } } },
			data: { label: 'Realtime' },
		});

		expect(updated.data.map((row: any) => row.id)).toEqual([a1]);
		expect(await labels(api, [a1])).toEqual(['Realtime']);

		const deleted = await realtime(api, tenantReaderToken, {
			action: 'delete',
			query: { filter: { label: { _eq: 'Realtime' } } },
		});

		expect(deleted.data).toEqual([a1]);
		expect(await labels(api, [a1])).toEqual([null]);
	});
});

const patchUsersByQuery = (api: Api, query: Record<string, any>) =>
	request(api.url)
		.patch('/users')
		.send({ query, data: { first_name: 'Edited' } })
		.set('Authorization', `Bearer ${userEditorToken}`);

describe('User query updates select only readable users', () => {
	test('refuses a filter on a user field the role cannot read', async ({ api, scenario }) => {
		const response = await patchUsersByQuery(api, { filter: { title: { _eq: 'Visible title' } } });

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
		expect(await firstName(api, scenario.users.visible.id)).toBe('Original');
	});

	test('does not select an updatable user outside the read scope', async ({ api, scenario }) => {
		const response = await patchUsersByQuery(api, { filter: { email: { _eq: scenario.users.hidden.email } } });

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual([]);
		expect(await firstName(api, scenario.users.hidden.id)).toBe('Original');
	});

	test('updates a readable user it may update', async ({ api, scenario }) => {
		const response = await patchUsersByQuery(api, { filter: { email: { _eq: scenario.users.visible.email } } });

		expect(response.statusCode).toBe(200);
		expect(response.body.data.map((row: any) => row.id)).toEqual([scenario.users.visible.id]);
		expect(await firstName(api, scenario.users.visible.id)).toBe('Edited');
	});
});

async function runFlow(api: Api, operation: { type: string; options: Record<string, any> }, token?: string) {
	const admin = `Bearer ${api.adminToken}`;

	const flow = await setupRequest(api.url)
		.post('/flows')
		.send({
			name: `MQE flow ${randomUUID().slice(0, 8)}`,
			status: 'active',
			accountability: null,
			trigger: 'webhook',
			options: { method: 'POST' },
		})
		.set('Authorization', admin);

	const flowId = flow.body.data.id as string;

	try {
		await setupRequest(api.url)
			.patch(`/flows/${flowId}`)
			.send({
				operation: { ...operation, flow: flowId, key: 'mutation', name: 'Mutation', position_x: 19, position_y: 1 },
			})
			.set('Authorization', admin);

		const deadline = Date.now() + 10000;

		for (;;) {
			const trigger = request(api.url).post(`/flows/trigger/${flowId}`);
			if (token) trigger.set('Authorization', `Bearer ${token}`);
			const response = await trigger;
			if (response.statusCode !== 403 || Date.now() > deadline) return response;
			await sleep(25);
		}
	} finally {
		await request(api.url).delete(`/flows/${flowId}`).set('Authorization', admin);
	}
}

describe('Flow query operations select only readable records', () => {
	test('refuses a hidden-field query in an update running as a role', async ({ api, fixture, scenario }) => {
		const response = await runFlow(api, {
			type: 'item-update',
			options: {
				collection: itemsCollection,
				query: { filter: { secret: { _eq: 'beta' } } },
				payload: { label: 'Flow' },
				permissions: fixture.tenantReaderRole,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
		expect(await labels(api, [scenario.items.a2])).toEqual(['A two']);
	});

	test("refuses a hidden-field query in an update running with the trigger's permissions", async ({
		api,
		scenario,
	}) => {
		const response = await runFlow(
			api,
			{
				type: 'item-update',
				options: {
					collection: itemsCollection,
					query: { filter: { secret: { _eq: 'beta' } } },
					payload: { label: 'Flow' },
					permissions: '$trigger',
				},
			},
			tenantReaderToken
		);

		expect(response.statusCode).toBe(200);
		expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
		expect(await labels(api, [scenario.items.a2])).toEqual(['A two']);
	});

	test('does not delete a writable record outside the read scope of the role', async ({ api, fixture, scenario }) => {
		const response = await runFlow(api, {
			type: 'item-delete',
			options: {
				collection: itemsCollection,
				query: { filter: { label: { _eq: 'B one' } } },
				permissions: fixture.tenantReaderRole,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toEqual([]);
		expect(await labels(api, [scenario.items.b1])).toEqual(['B one']);
	});

	test('selects by any field with full permissions', async ({ api, scenario }) => {
		const response = await runFlow(api, {
			type: 'item-update',
			options: {
				collection: itemsCollection,
				query: { filter: { secret: { _eq: 'beta' } } },
				payload: { label: 'Flow' },
				permissions: '$full',
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toEqual([scenario.items.a2]);
		expect(await labels(api, [scenario.items.a2])).toEqual(['Flow']);
	});
});

const updateChildren = (api: Api, token: string, parent: number, children: Record<string, any>[]) =>
	requestGraphQL(api.url, false, token, {
		mutation: {
			[`update_${parentCollection}_item`]: {
				__args: { id: parent, data: { children } },
				id: true,
			},
		},
	});

describe('GraphQL nested one-to-many saves remove only readable related items', () => {
	test('refuses a full-list save from a role that cannot read the children', async ({ api, scenario }) => {
		const response = await updateChildren(api, childWriteOnlyToken, scenario.soloParent, [
			{ id: scenario.children.solo, name: 'GraphQL edit' },
		]);

		expect(response.body.data[`update_${parentCollection}_item`]).toBeNull();
		expect(response.body.errors).toHaveLength(1);
		expect(await childRow(api, scenario.children.solo)).toEqual({ name: 'Solo child', parent_id: scenario.soloParent });
	});

	test('removes only readable children from an empty list', async ({ api, scenario }) => {
		const response = await updateChildren(api, childPartialReadToken, scenario.parent, []);

		expect(response.body.errors).toBeUndefined();
		expect((await childRow(api, scenario.children.visible)).parent_id).toBeNull();
		expect((await childRow(api, scenario.children.hidden)).parent_id).toBe(scenario.parent);
	});

	test('keeps unreadable children linked when updating a readable one', async ({ api, scenario }) => {
		const response = await updateChildren(api, childPartialReadToken, scenario.parent, [
			{ id: scenario.children.visible, name: 'GraphQL edit' },
		]);

		expect(response.body.errors).toBeUndefined();

		expect(await childRow(api, scenario.children.visible)).toEqual({
			name: 'GraphQL edit',
			parent_id: scenario.parent,
		});

		expect((await childRow(api, scenario.children.hidden)).parent_id).toBe(scenario.parent);
	});

	test('round-trips a full list for a role that reads every child', async ({ api, scenario }) => {
		const response = await updateChildren(api, childReaderToken, scenario.parent, [
			{ id: scenario.children.visible, name: 'GraphQL edit' },
			{ id: scenario.children.hidden },
		]);

		expect(response.body.errors).toBeUndefined();

		expect(await childRow(api, scenario.children.visible)).toEqual({
			name: 'GraphQL edit',
			parent_id: scenario.parent,
		});

		expect((await childRow(api, scenario.children.hidden)).parent_id).toBe(scenario.parent);
	});
});
