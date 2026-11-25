import { expect } from 'vitest';
import targetsJson from '../fixtures/flows/data-operation-targets.json';
import type { Api } from '../fixtures/environment';
import { stepOutput } from '../fixtures/flow-outcomes';
import { defineFlows, flowFixtures, type FlowDefinition, type FlowFixture } from '../fixtures/flows';
import { createIdentityTest, USER } from '../fixtures/identities';
import request, { setupRequest } from '../fixtures/request';
import { CreateCollection, CreateFieldO2M } from '../fixtures/schema';
import { initializeFixtures } from '../harness/fixture-setup.mjs';
import { sleep } from '../utils/sleep';

initializeFixtures();

const test = createIdentityTest({ hookFixtures: ['flow-target-receipt'] }).extend(flowFixtures);

type Row = Record<string, unknown> & { id: number };

const asAdmin = (api: Api) => `Bearer ${api.adminToken}`;

function flowNamed(
	name: string,
	stepOptions: Record<string, unknown> = {},
	flowOptions: Record<string, unknown> = {}
): FlowDefinition {
	const flow = defineFlows('data-operation-targets.json', targetsJson).find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	const step = flow.operations[0]!;
	step.options = { ...step.options, ...stepOptions };
	flow.options = { ...flow.options, ...flowOptions };
	return flow;
}

/** Creates a collection with an integer key and the given fields, then seeds its rows. */
async function createRows(
	api: Api,
	collection: string,
	rows: object[],
	fields: Record<string, string> = { name: 'string' }
): Promise<Row[]> {
	await CreateCollection(api, {
		collection,
		fields: Object.entries(fields).map(([field, type]) => ({ field, type, meta: {}, schema: {} })),
	});

	if (rows.length === 0) return [];

	const response = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.set('Authorization', asAdmin(api))
		.send(rows);

	return response.body.data;
}

const rowsOf = (api: Api, collection: string) => api.database(collection).select('*').orderBy('id');

function post(api: Api, flow: FlowDefinition, body: Record<string, unknown>, bearer: string | null = null) {
	const pending = request(api.url).post(`/flows/trigger/${flow.id}`).send(body);
	return bearer === null ? pending : pending.set('Authorization', bearer);
}

async function identity(api: Api, key: string): Promise<{ role: string; bearer: string }> {
	const row = await api.database('directus_users').where('email', USER[key]!.EMAIL).first('role');
	return { role: row.role, bearer: `Bearer ${USER[key]!.TOKEN}` };
}

async function grant(
	api: Api,
	role: string,
	collection: string,
	action: string,
	fields: string[],
	permissions: Record<string, unknown> = {}
) {
	await setupRequest(api.url)
		.post('/permissions')
		.set('Authorization', asAdmin(api))
		.send({ role, collection, action, fields, permissions });
}

async function expectLastRunFailed(flows: FlowFixture, flow: FlowDefinition, code: string) {
	const run = (await flows.runs(flow.id)).at(-1)!;

	expect(run).toMatchObject({ outcome: 'failed', reason: 'STEP_FAILED' });
	expect(run.last).toMatchObject({ code });
}

/** Polls the API's log for a marker, because a line can reach the file after its response. */
async function logIndexOf(api: Api, marker: string): Promise<number> {
	const deadline = performance.now() + 5000;

	while (performance.now() < deadline) {
		const index = (await api.readLogs()).indexOf(marker);
		if (index >= 0) return index;
		await sleep(25);
	}

	return -1;
}

test('an empty list of keys changes nothing and fires no update event, and a missing key fails', async ({
	api,
	flows,
}) => {
	const [row] = await createRows(api, 'test_flow_targets', [{ name: 'original' }]);
	const scalar = flowNamed('Targets update');
	const studio = flowNamed('Targets update', { key: ['{{ $trigger.body.ids }}'] });

	for (const [flow, shape] of [
		[scalar, 'scalar'],
		[studio, 'studio'],
	] as const) {
		await flows.install([flow]);

		expect((await post(api, flow, { ids: [], marker: `targets-empty-${shape}` })).body).toEqual([]);

		for (const ids of [null, '']) {
			await post(api, flow, { ids, marker: 'targets-missing' });
		}

		const runs = await flows.runs(flow.id);

		expect(runs.map((run) => run.steps)).toEqual([
			[{ key: 'update', path: 'success' }],
			[{ key: 'update', path: 'failure' }],
			[{ key: 'update', path: 'failure' }],
		]);

		expect(runs.slice(1).map((run) => (run.last as { code?: string }).code)).toEqual([
			'INVALID_PAYLOAD',
			'INVALID_PAYLOAD',
		]);
	}

	expect(await rowsOf(api, 'test_flow_targets')).toEqual([row]);

	expect((await post(api, studio, { ids: row!.id, marker: 'targets-real' })).body).toEqual(row!.id);

	// Log lines arrive in order, so no earlier call fired an event if no receipt precedes this call's receipts.
	const filtered = await logIndexOf(api, 'flow-target-filter targets-real');
	const acted = await logIndexOf(api, 'flow-target-action targets-real');
	const earlier = (await api.readLogs()).slice(0, Math.min(filtered, acted));

	expect(filtered).toBeGreaterThanOrEqual(0);
	expect(acted).toBeGreaterThanOrEqual(0);
	expect(earlier).not.toContain('flow-target-filter');
	expect(earlier).not.toContain('flow-target-action');
	expect(await rowsOf(api, 'test_flow_targets')).toEqual([{ ...row, name: 'targets-real' }]);
});

test("an empty selection from one tenant's caller never reaches another tenant's rows", async ({ api, flows }) => {
	const rows = await createRows(
		api,
		'test_flow_targets_tenants',
		[
			{ name: 'a1', tenant: 'a' },
			{ name: 'b1', tenant: 'b' },
			{ name: 'b2', tenant: 'b' },
		],
		{ name: 'string', tenant: 'string' }
	);

	const caller = await identity(api, 'APP_ACCESS');
	await grant(api, caller.role, 'test_flow_targets_tenants', 'read', ['*'], { tenant: { _eq: 'a' } });

	const visible = await request(api.url).get('/items/test_flow_targets_tenants').set('Authorization', caller.bearer);

	expect(visible.body.data).toEqual([rows[0]]);

	const flow = flowNamed('Targets update', { collection: 'test_flow_targets_tenants', emitEvents: false });
	await flows.install([flow]);

	for (const ids of [[], null]) {
		await post(api, flow, { ids, marker: 'widened' }, caller.bearer);
	}

	expect((await flows.runs(flow.id)).map((run) => run.steps[0]!.path)).toEqual(['success', 'failure']);
	expect(await rowsOf(api, 'test_flow_targets_tenants')).toEqual(rows);

	await post(api, flow, { ids: [rows[0]!.id], marker: 'tenant-a' }, caller.bearer);

	expect(await rowsOf(api, 'test_flow_targets_tenants')).toEqual([{ ...rows[0], name: 'tenant-a' }, rows[1], rows[2]]);
});

test('Delete Data deletes nothing for an empty or missing selection', async ({ api, flows }) => {
	const rows = await createRows(api, 'test_flow_targets_delete', [{ name: 'one' }, { name: 'two' }]);
	const flow = flowNamed('Targets delete', { collection: 'test_flow_targets_delete' });
	await flows.install([flow]);

	expect((await post(api, flow, { ids: [] })).body).toEqual([]);
	await post(api, flow, { ids: null });
	await expectLastRunFailed(flows, flow, 'INVALID_PAYLOAD');
	expect(await rowsOf(api, 'test_flow_targets_delete')).toEqual(rows);
});

test('a public Read Data webhook returns no records when the requested key is empty', async ({ api, flows }) => {
	const [first] = await createRows(api, 'test_flow_targets_read', [
		{ name: 'targets-read-alpha' },
		{ name: 'targets-read-beta' },
	]);

	const flow = flowNamed('Targets read', { collection: 'test_flow_targets_read' });
	await flows.install([flow]);

	const empty = await request(api.url).get(`/flows/trigger/${flow.id}`).query({ id: '' });

	await expectLastRunFailed(flows, flow, 'INVALID_PAYLOAD');
	expect(empty.text).not.toContain('targets-read-alpha');
	expect(empty.text).not.toContain('targets-read-beta');

	const keyed = await request(api.url).get(`/flows/trigger/${flow.id}`).query({ id: first!.id });

	expect(keyed.body).toEqual(first);
});

test('a key of zero reads, updates and deletes only the record keyed zero', async ({ api, flows }) => {
	await setupRequest(api.url)
		.post('/collections')
		.set('Authorization', asAdmin(api))
		.send({
			collection: 'test_flow_targets_zero',
			meta: {},
			schema: {},
			fields: [
				{
					field: 'id',
					type: 'integer',
					meta: { hidden: false, interface: 'input', readonly: false },
					schema: { is_primary_key: true, has_auto_increment: false },
				},
				{ field: 'name', type: 'string', meta: {}, schema: {} },
			],
		});

	await setupRequest(api.url)
		.post('/items/test_flow_targets_zero')
		.set('Authorization', asAdmin(api))
		.send([
			{ id: 0, name: 'zero' },
			{ id: 1, name: 'one' },
			{ id: 2, name: 'two' },
		]);

	const read = flowNamed(
		'Targets read',
		{ collection: 'test_flow_targets_zero', key: '{{ $trigger.body.id }}' },
		{ method: 'POST' }
	);

	const update = flowNamed('Targets update', { collection: 'test_flow_targets_zero', emitEvents: false });
	const remove = flowNamed('Targets delete', { collection: 'test_flow_targets_zero' });
	await flows.install([read, update, remove]);

	expect((await post(api, read, { id: 0 })).body).toEqual({ id: 0, name: 'zero' });

	// A response body of `0` is sent empty, so the returned key is read from the run.
	await post(api, update, { ids: 0, marker: 'zero-updated' });
	expect(stepOutput((await flows.runs(update.id))[0]!, 'update')).toBe(0);

	expect(await rowsOf(api, 'test_flow_targets_zero')).toEqual([
		{ id: 0, name: 'zero-updated' },
		{ id: 1, name: 'one' },
		{ id: 2, name: 'two' },
	]);

	await post(api, remove, { ids: 0 });
	expect(stepOutput((await flows.runs(remove.id))[0]!, 'delete')).toBe(0);

	expect(await rowsOf(api, 'test_flow_targets_zero')).toEqual([
		{ id: 1, name: 'one' },
		{ id: 2, name: 'two' },
	]);
});

test('query mode changes only what the query selects', async ({ api, flows }) => {
	await createRows(
		api,
		'test_flow_targets_query',
		[
			{ name: 'a', status: 'open' },
			{ name: 'b', status: 'closed' },
			{ name: 'c', status: 'open' },
			{ name: 'd', status: 'closed' },
		],
		{ name: 'string', status: 'string' }
	);

	const filtered = flowNamed('Targets update', {
		collection: 'test_flow_targets_query',
		emitEvents: false,
		key: undefined,
		query: { filter: { status: { _eq: 'open' } } },
	});

	await flows.install([filtered]);
	await post(api, filtered, { marker: 'filtered' });
	const afterFilter = await rowsOf(api, 'test_flow_targets_query');

	expect(afterFilter.map((row) => [row.status, row.name])).toEqual([
		['open', 'filtered'],
		['closed', 'b'],
		['open', 'filtered'],
		['closed', 'd'],
	]);

	const limited = flowNamed('Targets update', {
		collection: 'test_flow_targets_query',
		emitEvents: false,
		key: undefined,
		query: { limit: 2 },
	});

	await flows.install([limited]);
	await post(api, limited, { marker: 'limited' });
	const afterLimit = await rowsOf(api, 'test_flow_targets_query');

	expect(afterLimit.filter((row) => row.name === 'limited')).toHaveLength(2);
});

test('Update and Delete Data without a target fail, and Update without a payload returns null', async ({
	api,
	flows,
}) => {
	const rows = await createRows(
		api,
		'test_flow_targets_none',
		[
			{ name: 'a', rank: 5 },
			{ name: 'b', rank: 15 },
		],
		{ name: 'string', rank: 'integer' }
	);

	const queries = [undefined, { filter: { _and: [] } }, { filter: { rank: { _between: [10] } } }];

	for (const query of queries) {
		const update = flowNamed('Targets update', {
			collection: 'test_flow_targets_none',
			emitEvents: false,
			key: undefined,
			query,
		});

		const remove = flowNamed('Targets delete', { collection: 'test_flow_targets_none', key: undefined, query });
		await flows.install([update, remove]);

		await post(api, update, { marker: 'widened' });
		await expectLastRunFailed(flows, update, 'INVALID_CONFIG');
		await post(api, remove, {});
		await expectLastRunFailed(flows, remove, 'INVALID_CONFIG');
	}

	const payloadless = flowNamed('Targets update', {
		collection: 'test_flow_targets_none',
		key: undefined,
		payload: undefined,
	});

	await flows.install([payloadless]);
	await post(api, payloadless, {});
	const [run] = await flows.runs(payloadless.id);

	expect(run!.steps).toEqual([{ key: 'update', path: 'success' }]);
	expect(stepOutput(run!, 'update')).toBe(null);
	expect(await rowsOf(api, 'test_flow_targets_none')).toEqual(rows);
});

test('filters the builder turns into conditions still select only their rows', async ({ api, flows }) => {
	await createRows(
		api,
		'test_flow_targets_filters',
		[
			{ name: 'a', status: 'open', rank: 5 },
			{ name: 'b', status: 'closed', rank: 15 },
			{ name: 'c', status: 'open', rank: 25 },
		],
		{ name: 'string', status: 'string', rank: 'integer' }
	);

	const update = (query: Record<string, unknown>) =>
		flowNamed('Targets update', {
			collection: 'test_flow_targets_filters',
			emitEvents: false,
			key: undefined,
			query,
		});

	const ranged = update({ filter: { rank: { _between: [10, 30] } } });
	await flows.install([ranged]);
	await post(api, ranged, { marker: 'ranged' });

	expect((await rowsOf(api, 'test_flow_targets_filters')).map((row) => row.name)).toEqual(['a', 'ranged', 'ranged']);

	const either = update({ filter: { _or: [{ status: { _eq: 'open' } }, { _and: [] }] } });
	await flows.install([either]);
	await post(api, either, { marker: 'either' });

	expect((await rowsOf(api, 'test_flow_targets_filters')).map((row) => row.name)).toEqual([
		'either',
		'ranged',
		'either',
	]);

	const parents = await createRows(api, 'test_flow_targets_orders', [{ name: 'with' }, { name: 'without' }]);
	await createRows(api, 'test_flow_targets_lines', [], { sku: 'string' });

	await CreateFieldO2M(api, {
		collection: 'test_flow_targets_orders',
		field: 'lines',
		otherCollection: 'test_flow_targets_lines',
		otherField: 'order_id',
	});

	await setupRequest(api.url)
		.post('/items/test_flow_targets_lines')
		.set('Authorization', asAdmin(api))
		.send([
			{ sku: 'match', order_id: parents[0]!.id },
			{ sku: 'other', order_id: parents[1]!.id },
		]);

	const related = flowNamed('Targets update', {
		collection: 'test_flow_targets_orders',
		emitEvents: false,
		key: undefined,
		query: { filter: { lines: { _some: { sku: { _eq: 'match' } } } } },
	});

	await flows.install([related]);
	await post(api, related, { marker: 'related' });

	expect((await rowsOf(api, 'test_flow_targets_orders')).map((row) => row.name)).toEqual(['related', 'without']);
});

test('a filter that is the only selector must pass permissions and compile before any item is read', async ({
	api,
	flows,
}) => {
	const rows = await createRows(
		api,
		'test_flow_targets_guarded',
		[
			{ name: 'a', status: 'open' },
			{ name: 'b', status: 'open' },
		],
		{ name: 'string', status: 'string' }
	);

	const update = (query: Record<string, unknown>, permissions: string) =>
		flowNamed('Targets update', {
			collection: 'test_flow_targets_guarded',
			emitEvents: false,
			key: undefined,
			permissions,
			query,
		});

	const startMarker = 'flow-target-query targets-guarded-start';

	await setupRequest(api.url)
		.get('/items/test_flow_targets_guarded')
		.query({ search: 'targets-guarded-start' })
		.set('Authorization', asAdmin(api));

	const start = await logIndexOf(api, startMarker);

	expect(start).toBeGreaterThanOrEqual(0);

	const missingField = update({ filter: { missing: { _eq: 1 } } }, '$full');
	await flows.install([missingField]);
	await post(api, missingField, { marker: 'widened' });
	await expectLastRunFailed(flows, missingField, 'INVALID_QUERY');

	const caller = await identity(api, 'APP_ACCESS');
	await grant(api, caller.role, 'test_flow_targets_guarded', 'read', ['id', 'name']);
	await grant(api, caller.role, 'test_flow_targets_guarded', 'update', ['*']);

	const hiddenField = update({ filter: { status: { _eq: 'open' } } }, '$trigger');
	await flows.install([hiddenField]);
	const hidden = await post(api, hiddenField, { marker: 'widened' }, caller.bearer);
	await expectLastRunFailed(flows, hiddenField, 'FORBIDDEN');

	const absentField = update({ filter: { nope: { _eq: 'open' } } }, '$trigger');
	await flows.install([absentField]);
	const absent = await post(api, absentField, { marker: 'widened' }, caller.bearer);
	await expectLastRunFailed(flows, absentField, 'FORBIDDEN');

	expect([absent.status, absent.text]).toEqual([hidden.status, hidden.text]);
	expect(await rowsOf(api, 'test_flow_targets_guarded')).toEqual(rows);

	const readableField = update({ filter: { name: { _eq: 'a' } } }, '$trigger');
	await flows.install([readableField]);
	await post(api, readableField, { marker: 'permitted' }, caller.bearer);

	// Log lines arrive in order, so no refused call reached the items service if no query receipt falls between the
	// start receipt and this one.
	const permitted = await logIndexOf(api, 'flow-target-query name');

	expect(permitted).toBeGreaterThan(start);
	expect((await api.readLogs()).slice(start + startMarker.length, permitted)).not.toContain('flow-target-query');

	expect(await rowsOf(api, 'test_flow_targets_guarded')).toEqual([{ ...rows[0], name: 'permitted' }, rows[1]]);
});

test('a reference resolving to a value that is not an ID fails without writing', async ({ api, flows }) => {
	const rows = await createRows(api, 'test_flow_targets_invalid', [{ name: 'a' }]);

	for (const key of ['{{ $trigger.body.ids }}', ['{{ $trigger.body.ids }}']]) {
		const flow = flowNamed('Targets update', { collection: 'test_flow_targets_invalid', emitEvents: false, key });
		await flows.install([flow]);
		await post(api, flow, { ids: true, marker: 'widened' });
		await expectLastRunFailed(flows, flow, 'INVALID_PAYLOAD');
	}

	expect(await rowsOf(api, 'test_flow_targets_invalid')).toEqual(rows);
});

test('Read Data still lists records without keys, and picks fields with keys and a query', async ({ api, flows }) => {
	const rows = await createRows(api, 'test_flow_targets_listing', [{ name: 'first' }, { name: 'second' }]);

	const listing = flowNamed('Targets read', { collection: 'test_flow_targets_listing', key: undefined });
	await flows.install([listing]);

	const listed = (await request(api.url).get(`/flows/trigger/${listing.id}`)).body;

	expect(listed).toHaveLength(2);
	expect(listed).toEqual(expect.arrayContaining(rows));

	const picked = flowNamed('Targets read', {
		collection: 'test_flow_targets_listing',
		query: { fields: ['name'] },
	});

	await flows.install([picked]);

	const response = await request(api.url).get(`/flows/trigger/${picked.id}`).query({ id: rows[1]!.id });

	expect(response.body).toEqual({ name: 'second' });
});

test('a blocking flow refuses a create when its keyed step gets a missing key, and allows an empty list', async ({
	api,
	flows,
}) => {
	const parents = await createRows(api, 'test_flow_targets_parents', [{ name: 'parent' }]);
	await createRows(api, 'test_flow_targets_children', [], { name: 'string', parent_ids: 'json' });
	await flows.install([flowNamed('Targets blocking create')]);

	const refused = await request(api.url)
		.post('/items/test_flow_targets_children')
		.set('Authorization', asAdmin(api))
		.send({ name: 'refused', parent_ids: null });

	expect(refused.status).toBe(400);
	expect(refused.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');

	const allowed = await request(api.url)
		.post('/items/test_flow_targets_children')
		.set('Authorization', asAdmin(api))
		.send({ name: 'allowed', parent_ids: [] });

	expect(allowed.status).toBe(200);

	expect((await rowsOf(api, 'test_flow_targets_children')).map((row) => row.name)).toEqual(['allowed']);
	expect(await rowsOf(api, 'test_flow_targets_parents')).toEqual(parents);
});

test('Update and Delete Data with keys and a query saved together fail, while the same query alone selects', async ({
	api,
	flows,
}) => {
	const [match] = await createRows(
		api,
		'test_flow_targets_both',
		[
			{ name: 'match', tag: 'target' },
			{ name: 'other', tag: 'keep' },
		],
		{ name: 'string', tag: 'string' }
	);

	const query = { filter: { tag: { _eq: 'target' } } };

	for (const ids of [[match!.id], []]) {
		const update = flowNamed('Targets update', { collection: 'test_flow_targets_both', emitEvents: false, query });
		const remove = flowNamed('Targets delete', { collection: 'test_flow_targets_both', query });
		await flows.install([update, remove]);

		await post(api, update, { ids, marker: 'both' });
		await expectLastRunFailed(flows, update, 'INVALID_CONFIG');
		await post(api, remove, { ids });
		await expectLastRunFailed(flows, remove, 'INVALID_CONFIG');
	}

	expect((await rowsOf(api, 'test_flow_targets_both')).map((row) => row.name)).toEqual(['match', 'other']);

	const queryOnly = flowNamed('Targets update', {
		collection: 'test_flow_targets_both',
		emitEvents: false,
		key: undefined,
		query,
	});

	await flows.install([queryOnly]);
	await post(api, queryOnly, { marker: 'query-only' });

	expect((await rowsOf(api, 'test_flow_targets_both')).map((row) => row.name)).toEqual(['query-only', 'other']);

	const removeOnly = flowNamed('Targets delete', { collection: 'test_flow_targets_both', key: undefined, query });
	await flows.install([removeOnly]);
	await post(api, removeOnly, {});

	expect((await rowsOf(api, 'test_flow_targets_both')).map((row) => row.name)).toEqual(['other']);
});
