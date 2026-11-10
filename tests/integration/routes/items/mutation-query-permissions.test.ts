import { randomUUID } from 'node:crypto';
import { describe, expect, inject } from 'vitest';
import { apiTest, type Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateField, CreateFieldM2O, CreateFieldO2M } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const vendor = inject('integration').vendor;
const runId = randomUUID().slice(0, 8);
const itemsCollection = `test_mqp_items_${runId}`;
const ownersCollection = `test_mqp_owners_${runId}`;
const parentCollection = `test_mqp_parent_${runId}`;
const childCollection = `test_mqp_child_${runId}`;
const taskCollection = `test_mqp_task_${runId}`;

const tenantReaderToken = `MqpTenantReader_${runId}`;
const writeOnlyToken = `MqpWriteOnly_${runId}`;
const parentOnlyToken = `MqpParentOnly_${runId}`;
const childPartialReadToken = `MqpChildPartialRead_${runId}`;
const childFieldRestrictedToken = `MqpChildFieldRestricted_${runId}`;
const childWriteOnlyToken = `MqpChildWriteOnly_${runId}`;
const roleManagerToken = `MqpRoleManager_${runId}`;
const roleManagerNarrowToken = `MqpRoleManagerNarrow_${runId}`;

const visibleEmailMarker = `mqp-visible-${runId}`;

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
		.send({ email: `${token.toLowerCase()}-${vendor}@tests.com`, password: 'MqpPassword1', token, role: roleId })
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

type Scenario = {
	items: Record<'a1' | 'a2' | 'locked' | 'b1' | 'c1', number>;
	parent: number;
	emptyParent: number;
	soloParent: number;
	children: Record<'visible' | 'hidden' | 'solo', number>;
	tasks: Record<'visible' | 'hidden', number>;
};

async function createItem(api: Api, collection: string, body: Record<string, any>) {
	const response = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.send(body)
		.set('Authorization', `Bearer ${api.adminToken}`);

	return response.body.data.id as number;
}

async function createRows(api: Api): Promise<Scenario> {
	const ownerOne = await createItem(api, ownersCollection, { name: 'Owner one', code: 'x1' });
	const ownerTwo = await createItem(api, ownersCollection, { name: 'Owner two', code: 'x2' });

	const item = (label: string, secret: string, tenant: string, owner: number | null = null) =>
		createItem(api, itemsCollection, { label, secret, tenant, owner });

	const items = {
		a1: await item('A one', 'alpha', 'A', ownerOne),
		a2: await item('A two', 'beta', 'A', ownerTwo),
		locked: await item('Locked', 'gamma', 'A'),
		b1: await item('B one', 'alpha', 'B'),
		c1: await item('C one', 'alpha', 'C'),
	};

	await setupRequest(api.url)
		.patch(`/items/${itemsCollection}/${items.a2}`)
		.send({ reference: items.a1 })
		.set('Authorization', `Bearer ${api.adminToken}`);

	await setupRequest(api.url)
		.patch(`/items/${itemsCollection}/${items.a1}`)
		.send({ pointer: items.b1 })
		.set('Authorization', `Bearer ${api.adminToken}`);

	const parent = await createItem(api, parentCollection, { name: 'Parent' });
	const emptyParent = await createItem(api, parentCollection, { name: 'Empty parent' });
	const soloParent = await createItem(api, parentCollection, { name: 'Solo parent' });

	return {
		items,
		parent,
		emptyParent,
		soloParent,
		children: {
			visible: await createItem(api, childCollection, { name: 'Visible child', parent_id: parent }),
			hidden: await createItem(api, childCollection, { name: 'Hidden child', parent_id: parent }),
			solo: await createItem(api, childCollection, { name: 'Solo child', parent_id: soloParent }),
		},
		tasks: {
			visible: await createItem(api, taskCollection, { name: 'Visible task', parent_id: parent }),
			hidden: await createItem(api, taskCollection, { name: 'Hidden task', parent_id: parent }),
		},
	};
}

async function readRow(api: Api, collection: string, id: number | string, fields = '*') {
	const response = await request(api.url)
		.get(`/items/${collection}/${id}`)
		.query({ fields })
		.set('Authorization', `Bearer ${api.adminToken}`);

	return response.statusCode === 200 ? response.body.data : null;
}

const labels = async (api: Api, ids: number[]) =>
	Promise.all(ids.map(async (id) => (await readRow(api, itemsCollection, id, 'label'))?.label ?? null));

function expectForbidden(response: { statusCode: number; body: any }) {
	expect(response.statusCode).toBe(403);
	expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
}

const test = apiTest.extend<{ schemaState: Prerequisite<void>; scenario: Scenario }>({
	schemaState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					const cleanups: Array<() => Promise<void>> = [];
					const track = (fn: () => Promise<void>) => cleanups.push(fn);

					try {
						for (const collection of [
							ownersCollection,
							itemsCollection,
							parentCollection,
							childCollection,
							taskCollection,
						]) {
							await CreateCollection(api, { collection });

							track(async () => {
								await request(api.url)
									.delete(`/collections/${collection}`)
									.set('Authorization', `Bearer ${api.adminToken}`);
							});
						}

						for (const field of ['name', 'code']) {
							await CreateField(api, { collection: ownersCollection, field, type: 'string' });
						}

						for (const field of ['label', 'secret', 'tenant']) {
							await CreateField(api, { collection: itemsCollection, field, type: 'string' });
						}

						for (const field of ['reference', 'pointer']) {
							await CreateField(api, { collection: itemsCollection, field, type: 'integer' });
						}

						await CreateFieldM2O(api, {
							collection: itemsCollection,
							field: 'owner',
							otherCollection: ownersCollection,
							primaryKeyType: 'integer',
						});

						for (const collection of [parentCollection, childCollection, taskCollection]) {
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

						await CreateFieldO2M(api, {
							collection: parentCollection,
							field: 'tasks',
							otherCollection: taskCollection,
							otherField: 'parent_id',
							primaryKeyType: 'integer',
							relationMeta: { one_deselect_action: 'delete' },
						});

						const writable = { _and: [{ tenant: { _in: ['A', 'B'] } }, { label: { _neq: 'Locked' } }] };

						const tenantReader = await createRoleUser(api, `MQP Tenant Reader ${runId}`, tenantReaderToken, track);

						await grant(api, tenantReader, itemsCollection, 'read', ['id', 'label', 'tenant', 'owner', 'pointer'], {
							tenant: { _eq: 'A' },
						});

						await grant(api, tenantReader, itemsCollection, 'update', ['label', 'secret'], writable);
						await grant(api, tenantReader, itemsCollection, 'delete', ['*'], writable);
						await grant(api, tenantReader, ownersCollection, 'read', ['id', 'name']);

						const writeOnly = await createRoleUser(api, `MQP Write Only ${runId}`, writeOnlyToken, track);
						await grant(api, writeOnly, itemsCollection, 'update', ['label'], writable);
						await grant(api, writeOnly, itemsCollection, 'delete', ['*'], writable);

						const parentOnly = await createRoleUser(api, `MQP Parent Only ${runId}`, parentOnlyToken, track);
						await grant(api, parentOnly, parentCollection, 'read', ['*']);
						await grant(api, parentOnly, parentCollection, 'update', ['*']);

						const hiddenChild = { name: { _nin: ['Hidden child', 'Hidden task'] } };

						const partial = await createRoleUser(api, `MQP Child Partial ${runId}`, childPartialReadToken, track);
						await grant(api, partial, parentCollection, 'read', ['*']);
						await grant(api, partial, parentCollection, 'update', ['*']);
						await grant(api, partial, childCollection, 'read', ['*'], hiddenChild);
						await grant(api, partial, childCollection, 'update', ['*']);
						await grant(api, partial, taskCollection, 'read', ['*'], hiddenChild);
						await grant(api, partial, taskCollection, 'delete', ['*']);

						const restricted = await createRoleUser(
							api,
							`MQP Child Field Restricted ${runId}`,
							childFieldRestrictedToken,
							track
						);

						await grant(api, restricted, parentCollection, 'read', ['*']);
						await grant(api, restricted, parentCollection, 'update', ['*']);
						await grant(api, restricted, childCollection, 'read', ['id', 'name']);
						await grant(api, restricted, childCollection, 'update', ['name']);
						await grant(api, restricted, childCollection, 'create', ['name', 'parent_id']);

						const childWriteOnly = await createRoleUser(
							api,
							`MQP Child Write Only ${runId}`,
							childWriteOnlyToken,
							track
						);

						await grant(api, childWriteOnly, parentCollection, 'read', ['*']);
						await grant(api, childWriteOnly, parentCollection, 'update', ['*']);
						await grant(api, childWriteOnly, childCollection, 'update', ['name']);
						await grant(api, childWriteOnly, childCollection, 'create', ['name', 'parent_id']);

						const visibleUsers = { email: { _contains: visibleEmailMarker } };

						for (const [name, token, userUpdate] of [
							[`MQP Role Manager ${runId}`, roleManagerToken, {}],
							[`MQP Role Manager Narrow ${runId}`, roleManagerNarrowToken, visibleUsers],
						] as const) {
							const manager = await createRoleUser(api, name, token, track);
							await grant(api, manager, 'directus_roles', 'read', ['*']);
							await grant(api, manager, 'directus_roles', 'delete', ['*']);
							await grant(api, manager, 'directus_users', 'read', ['*'], visibleUsers);
							await grant(api, manager, 'directus_users', 'update', ['*'], userUpdate);
							await grant(api, manager, 'directus_permissions', 'read', ['*']);
							await grant(api, manager, 'directus_permissions', 'delete', ['*']);
							await grant(api, manager, 'directus_presets', 'read', ['*']);
							await grant(api, manager, 'directus_presets', 'delete', ['*']);
						}

						await ready();
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
	scenario: [
		async ({ api, schemaState, task, skip }, use) => {
			requirePrerequisite(schemaState, 'mutation query schema and permissions', { task, skip });

			for (const table of [itemsCollection, ownersCollection, childCollection, taskCollection, parentCollection]) {
				await api.database(table).delete();
			}

			await use(await createRows(api));
		},
		{ auto: true },
	],
});

const patchByQuery = (api: Api, token: string, query: Record<string, any>, data: Record<string, any>) =>
	request(api.url).patch(`/items/${itemsCollection}`).send({ query, data }).set('Authorization', `Bearer ${token}`);

const deleteByQuery = (api: Api, token: string, query: Record<string, any>) =>
	request(api.url).delete(`/items/${itemsCollection}`).send({ query }).set('Authorization', `Bearer ${token}`);

describe('Query-based updates and deletes select only readable records', () => {
	test('rejects an update whose filter reads a hidden field, whether or not it matches', async ({ api, scenario }) => {
		for (const secret of ['beta', 'no such secret']) {
			const response = await patchByQuery(
				api,
				tenantReaderToken,
				{ filter: { secret: { _eq: secret } } },
				{ label: 'Probed' }
			);

			expectForbidden(response);
		}

		expect(await labels(api, [scenario.items.a2])).toEqual(['A two']);
	});

	test('rejects a delete whose filter reads a hidden field', async ({ api, scenario }) => {
		const response = await deleteByQuery(api, tenantReaderToken, { filter: { secret: { _eq: 'beta' } } });

		expectForbidden(response);
		expect(await readRow(api, itemsCollection, scenario.items.a2)).not.toBeNull();
	});

	test('treats an unreadable, unwritable row like an absent row', async ({ api, scenario }) => {
		for (const label of ['C one', 'No such label']) {
			const updated = await patchByQuery(
				api,
				tenantReaderToken,
				{ filter: { label: { _eq: label } } },
				{ label: 'Changed' }
			);

			expect(updated.statusCode).toBe(200);
			expect(updated.body.data).toEqual([]);

			const deleted = await deleteByQuery(api, tenantReaderToken, { filter: { label: { _eq: label } } });

			expect(deleted.statusCode).toBe(204);
			expect(deleted.body).toEqual({});
		}

		expect(await labels(api, [scenario.items.c1])).toEqual(['C one']);
	});

	test('does not discover a writable row outside the read scope', async ({ api, scenario }) => {
		const updated = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: { label: { _eq: 'B one' } } },
			{ label: 'Changed' }
		);

		expect(updated.statusCode).toBe(200);
		expect(updated.body.data).toEqual([]);

		const deleted = await deleteByQuery(api, tenantReaderToken, { filter: { label: { _eq: 'B one' } } });

		expect(deleted.statusCode).toBe(204);
		expect(await labels(api, [scenario.items.b1])).toEqual(['B one']);
	});

	const writableTenantA = { label: { _in: ['A one', 'A two'] } };

	test('rejects a hidden sort with a limit', async ({ api, scenario }) => {
		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: writableTenantA, sort: ['secret'], limit: 1 },
			{ label: 'Sorted' }
		);

		expectForbidden(response);
		expect(await labels(api, [scenario.items.a1, scenario.items.a2])).toEqual(['A one', 'A two']);
	});

	test('rejects a filter on a hidden related field', async ({ api, scenario }) => {
		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: { owner: { code: { _eq: 'x1' } } } },
			{ label: 'Related' }
		);

		expectForbidden(response);
		expect(await labels(api, [scenario.items.a1])).toEqual(['A one']);
	});

	test('searches only readable fields', async ({ api, scenario }) => {
		const response = await patchByQuery(api, tenantReaderToken, { search: 'beta' }, { label: 'Searched' });

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual([]);
		expect(await labels(api, [scenario.items.a2])).toEqual(['A two']);
	});

	test('rejects grouping on a hidden field', async ({ api, scenario }) => {
		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: writableTenantA, groupBy: ['secret'] },
			{ label: 'Grouped' }
		);

		expectForbidden(response);
		expect(await labels(api, [scenario.items.a1, scenario.items.a2])).toEqual(['A one', 'A two']);
	});

	test('rejects aggregating a hidden field', async ({ api, scenario }) => {
		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: writableTenantA, aggregate: { max: ['secret'] } },
			{ label: 'Aggregated' }
		);

		expectForbidden(response);
		expect(await labels(api, [scenario.items.a1, scenario.items.a2])).toEqual(['A one', 'A two']);
	});

	test('updates the selected record when an alias points the primary key at a hidden field', async ({
		api,
		scenario,
	}) => {
		const { a1, a2 } = scenario.items;

		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: { label: { _eq: 'A two' } }, alias: { id: 'reference' } },
			{ label: 'Aliased' }
		);

		expect(response.statusCode).toBe(200);
		expect(response.body.data.map((row: any) => row.id)).toEqual([a2]);
		expect(await labels(api, [a1, a2])).toEqual(['A one', 'Aliased']);
	});

	test('updates the selected record when an alias points the primary key at a readable field', async ({
		api,
		scenario,
	}) => {
		const { a1, b1 } = scenario.items;

		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: { label: { _eq: 'A one' } }, alias: { id: 'pointer' } },
			{ label: 'Aliased' }
		);

		expect(response.statusCode).toBe(200);
		expect(response.body.data.map((row: any) => row.id)).toEqual([a1]);
		expect(await labels(api, [a1, b1])).toEqual(['Aliased', 'B one']);
	});

	test('deletes the selected record when an alias points the primary key at a readable field', async ({
		api,
		scenario,
	}) => {
		const { a1, b1 } = scenario.items;

		const response = await deleteByQuery(api, tenantReaderToken, {
			filter: { label: { _eq: 'A one' } },
			alias: { id: 'pointer' },
		});

		expect(response.statusCode).toBe(204);
		expect(await labels(api, [a1, b1])).toEqual([null, 'B one']);
	});

	test('fails a whole update selection that includes a readable row outside the write scope', async ({
		api,
		scenario,
	}) => {
		const { a1, a2, locked } = scenario.items;

		expectForbidden(await patchByQuery(api, tenantReaderToken, { filter: { tenant: { _eq: 'A' } } }, { label: 'All' }));
		expect(await labels(api, [a1, a2, locked])).toEqual(['A one', 'A two', 'Locked']);
	});

	test('fails a whole delete selection that includes a readable row outside the write scope', async ({
		api,
		scenario,
	}) => {
		const { a1, a2, locked } = scenario.items;

		expectForbidden(await deleteByQuery(api, tenantReaderToken, { filter: { tenant: { _eq: 'A' } } }));
		expect(await labels(api, [a1, a2, locked])).toEqual(['A one', 'A two', 'Locked']);
	});

	test('updates and deletes a readable, writable selection', async ({ api, scenario }) => {
		const { a1, a2 } = scenario.items;

		const updated = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: { label: { _in: ['A one', 'A two'] } } },
			{ label: 'Renamed' }
		);

		expect(updated.statusCode).toBe(200);
		expect(updated.body.data.map((row: any) => row.id).sort()).toEqual([a1, a2].sort());
		expect(await labels(api, [a1, a2])).toEqual(['Renamed', 'Renamed']);

		const deleted = await deleteByQuery(api, tenantReaderToken, { filter: { label: { _eq: 'Renamed' } } });
		expect(deleted.statusCode).toBe(204);
		expect(await labels(api, [a1, a2])).toEqual([null, null]);
	});

	test('pages through a readable sort to the expected record', async ({ api, scenario }) => {
		const { a1, a2, locked } = scenario.items;

		const response = await patchByQuery(
			api,
			tenantReaderToken,
			{ filter: { tenant: { _eq: 'A' } }, sort: ['label'], limit: 1, offset: 1 },
			{ label: 'Paged' }
		);

		expect(response.statusCode).toBe(200);
		expect(response.body.data.map((row: any) => row.id)).toEqual([a2]);
		expect(await labels(api, [a1, a2, locked])).toEqual(['A one', 'Paged', 'Locked']);
	});

	test('lets an administrator select by any field', async ({ api, scenario }) => {
		const { a1, b1, c1 } = scenario.items;

		const response = await patchByQuery(
			api,
			api.adminToken,
			{ filter: { secret: { _eq: 'alpha' } } },
			{ label: 'Admin' }
		);

		expect(response.statusCode).toBe(200);
		expect(response.body.data.map((row: any) => row.id).sort()).toEqual([a1, b1, c1].sort());
		expect(await labels(api, [a1, b1, c1])).toEqual(['Admin', 'Admin', 'Admin']);
	});
});

describe('Write-only roles keep explicit-key writes', () => {
	test('updates and deletes by key without read access', async ({ api, scenario }) => {
		const { a1, a2 } = scenario.items;

		const updated = await request(api.url)
			.patch(`/items/${itemsCollection}/${a1}`)
			.send({ label: 'Written' })
			.set('Authorization', `Bearer ${writeOnlyToken}`);

		expect([200, 204]).toContain(updated.statusCode);

		const deleted = await request(api.url)
			.delete(`/items/${itemsCollection}/${a2}`)
			.set('Authorization', `Bearer ${writeOnlyToken}`);

		expect(deleted.statusCode).toBe(204);
		expect(await labels(api, [a1, a2])).toEqual(['Written', null]);
	});

	test('fails a mixed key batch atomically', async ({ api, scenario }) => {
		const { a1, c1 } = scenario.items;

		const response = await request(api.url)
			.patch(`/items/${itemsCollection}`)
			.send({ keys: [a1, c1], data: { label: 'Batch' } })
			.set('Authorization', `Bearer ${writeOnlyToken}`);

		expectForbidden(response);
		expect(await labels(api, [a1, c1])).toEqual(['A one', 'C one']);
	});

	test('cannot discover targets by query', async ({ api, scenario }) => {
		const { a1, a2 } = scenario.items;

		expectForbidden(
			await patchByQuery(api, writeOnlyToken, { filter: { label: { _eq: 'A one' } } }, { label: 'Found' })
		);

		expectForbidden(await deleteByQuery(api, writeOnlyToken, { filter: { label: { _eq: 'A two' } } }));

		expect(await labels(api, [a1, a2])).toEqual(['A one', 'A two']);
	});
});

const patchParent = (api: Api, token: string, parent: number, body: Record<string, any>) =>
	request(api.url).patch(`/items/${parentCollection}/${parent}`).send(body).set('Authorization', `Bearer ${token}`);

const childParent = async (api: Api, id: number) => (await readRow(api, childCollection, id, 'parent_id'))?.parent_id;

describe('Nested one-to-many removal selects only readable related items', () => {
	const parentName = async (api: Api, id: number) => (await readRow(api, parentCollection, id, 'name')).name;

	test('refuses a full-list removal without related read access, whatever exists', async ({ api, scenario }) => {
		for (const field of ['children', 'tasks']) {
			for (const parent of [scenario.parent, scenario.emptyParent]) {
				expectForbidden(await patchParent(api, parentOnlyToken, parent, { name: 'Renamed', [field]: [] }));
			}
		}

		expect(await parentName(api, scenario.parent)).toBe('Parent');
		expect(await parentName(api, scenario.emptyParent)).toBe('Empty parent');
		expect(await childParent(api, scenario.children.visible)).toBe(scenario.parent);
		expect(await readRow(api, taskCollection, scenario.tasks.visible)).not.toBeNull();
	});

	test('refuses a detailed delete without related read access, whether or not the id is related', async ({
		api,
		scenario,
	}) => {
		for (const [field, id] of [
			['children', scenario.children.visible],
			['children', 999000001],
			['tasks', scenario.tasks.visible],
			['tasks', 999000001],
		] as const) {
			expectForbidden(
				await patchParent(api, parentOnlyToken, scenario.parent, { name: 'Renamed', [field]: { delete: [id] } })
			);
		}

		expect(await parentName(api, scenario.parent)).toBe('Parent');
		expect(await childParent(api, scenario.children.visible)).toBe(scenario.parent);
		expect(await readRow(api, taskCollection, scenario.tasks.visible)).not.toBeNull();
	});

	test('removes only readable omitted items from a full list', async ({ api, scenario }) => {
		const children = await patchParent(api, childPartialReadToken, scenario.parent, { children: [] });
		expect([200, 204]).toContain(children.statusCode);

		expect(await childParent(api, scenario.children.visible)).toBeNull();
		expect(await childParent(api, scenario.children.hidden)).toBe(scenario.parent);

		const tasks = await patchParent(api, childPartialReadToken, scenario.parent, { tasks: [] });
		expect([200, 204]).toContain(tasks.statusCode);

		expect(await readRow(api, taskCollection, scenario.tasks.visible)).toBeNull();
		expect(await readRow(api, taskCollection, scenario.tasks.hidden)).not.toBeNull();
	});

	test('ignores a detailed delete naming an unreadable related item', async ({ api, scenario }) => {
		const hiddenChild = await patchParent(api, childPartialReadToken, scenario.parent, {
			children: { delete: [scenario.children.hidden] },
		});

		expect([200, 204]).toContain(hiddenChild.statusCode);
		expect(await childParent(api, scenario.children.hidden)).toBe(scenario.parent);

		const hiddenTask = await patchParent(api, childPartialReadToken, scenario.parent, {
			tasks: { delete: [scenario.tasks.hidden] },
		});

		expect([200, 204]).toContain(hiddenTask.statusCode);
		expect(await readRow(api, taskCollection, scenario.tasks.hidden)).not.toBeNull();
	});

	test('removes a readable related item named in a detailed delete', async ({ api, scenario }) => {
		const child = await patchParent(api, childPartialReadToken, scenario.parent, {
			children: { delete: [scenario.children.visible] },
		});

		expect([200, 204]).toContain(child.statusCode);
		expect(await childParent(api, scenario.children.visible)).toBeNull();

		const task = await patchParent(api, childPartialReadToken, scenario.parent, {
			tasks: { delete: [scenario.tasks.visible] },
		});

		expect([200, 204]).toContain(task.statusCode);
		expect(await readRow(api, taskCollection, scenario.tasks.visible)).toBeNull();
	});

	test('refuses a full-list save when the relationship field is unreadable', async ({ api, scenario }) => {
		const response = await patchParent(api, childFieldRestrictedToken, scenario.soloParent, {
			children: [{ id: scenario.children.solo, name: 'Renamed solo' }],
		});

		expectForbidden(response);
		expect((await readRow(api, childCollection, scenario.children.solo, 'name')).name).toBe('Solo child');
	});
});

describe("Nested saves in the app's payload shape", () => {
	for (const [label, token] of [
		['a role that reads the related item but not its relationship field', childFieldRestrictedToken],
		['a role with no related read access', childWriteOnlyToken],
	] as const) {
		test(`updates a related item for ${label} with an empty delete list`, async ({ api, scenario }) => {
			const response = await patchParent(api, token, scenario.soloParent, {
				children: { create: [], update: [{ id: scenario.children.solo, name: 'App edit' }], delete: [] },
			});

			expect([200, 204]).toContain(response.statusCode);

			const row = await readRow(api, childCollection, scenario.children.solo, 'name,parent_id');
			expect(row).toEqual({ name: 'App edit', parent_id: scenario.soloParent });
		});

		test(`creates a related item for ${label} with an empty delete list`, async ({ api, scenario }) => {
			const response = await patchParent(api, token, scenario.soloParent, {
				children: { create: [{ name: 'App create' }], update: [], delete: [] },
			});

			expect([200, 204]).toContain(response.statusCode);

			const created = await api.database(childCollection).where({ name: 'App create' }).first();
			expect(created?.parent_id).toBe(scenario.soloParent);
			expect(await childParent(api, scenario.children.solo)).toBe(scenario.soloParent);
		});
	}
});

describe('Role deletion cleans up every dependant', () => {
	async function createDoomedRole(api: Api) {
		const admin = `Bearer ${api.adminToken}`;
		const marker = randomUUID().slice(0, 8);

		const role = await setupRequest(api.url)
			.post('/roles')
			.send({ name: `MQP Doomed ${marker}`, admin_access: false })
			.set('Authorization', admin);

		const roleId = role.body.data.id as string;
		const users: string[] = [];

		for (const email of [`${visibleEmailMarker}-${marker}@tests.com`, `mqp-hidden-${marker}@tests.com`]) {
			const user = await setupRequest(api.url)
				.post('/users')
				.send({ email, password: 'MqpPassword1', role: roleId })
				.set('Authorization', admin);

			users.push(user.body.data.id);
		}

		const permission = await setupRequest(api.url)
			.post('/permissions')
			.send({ role: roleId, collection: itemsCollection, action: 'read', fields: ['*'] })
			.set('Authorization', admin);

		const preset = await setupRequest(api.url)
			.post('/presets')
			.send({ role: roleId, collection: itemsCollection, layout: 'tabular' })
			.set('Authorization', admin);

		return { roleId, users, permission: permission.body.data.id, preset: preset.body.data.id };
	}

	async function removeLeftovers(api: Api, doomed: Awaited<ReturnType<typeof createDoomedRole>>) {
		const admin = `Bearer ${api.adminToken}`;
		for (const id of doomed.users) await request(api.url).delete(`/users/${id}`).set('Authorization', admin);
		await request(api.url).delete(`/permissions/${doomed.permission}`).set('Authorization', admin);
		await request(api.url).delete(`/presets/${doomed.preset}`).set('Authorization', admin);
		await request(api.url).delete(`/roles/${doomed.roleId}`).set('Authorization', admin);
	}

	test('suspends and unassigns users the deleter cannot read', async ({ api }) => {
		const doomed = await createDoomedRole(api);

		try {
			const response = await request(api.url)
				.delete(`/roles/${doomed.roleId}`)
				.set('Authorization', `Bearer ${roleManagerToken}`);

			expect(response.statusCode).toBe(204);

			for (const id of doomed.users) {
				expect(await api.database('directus_users').where({ id }).first()).toMatchObject({
					status: 'suspended',
					role: null,
				});
			}

			expect(await api.database('directus_permissions').where({ id: doomed.permission }).first()).toBeUndefined();
			expect(await api.database('directus_presets').where({ id: doomed.preset }).first()).toBeUndefined();
			expect(await api.database('directus_roles').where({ id: doomed.roleId }).first()).toBeUndefined();
		} finally {
			await removeLeftovers(api, doomed);
		}
	});

	test('refuses the deletion without changes when the deleter cannot update every user', async ({ api }) => {
		const doomed = await createDoomedRole(api);

		try {
			const response = await request(api.url)
				.delete(`/roles/${doomed.roleId}`)
				.set('Authorization', `Bearer ${roleManagerNarrowToken}`);

			expectForbidden(response);

			expect(await api.database('directus_roles').where({ id: doomed.roleId }).first()).toBeDefined();
			expect(await api.database('directus_permissions').where({ id: doomed.permission }).first()).toBeDefined();
			expect(await api.database('directus_presets').where({ id: doomed.preset }).first()).toBeDefined();

			for (const id of doomed.users) {
				expect(await api.database('directus_users').where({ id }).first()).toMatchObject({
					status: 'active',
					role: doomed.roleId,
				});
			}
		} finally {
			await removeLeftovers(api, doomed);
		}
	});
});
