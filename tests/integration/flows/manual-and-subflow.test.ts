import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import manualJson from '../fixtures/flows/manual-and-subflow.json';
import type { Api } from '../fixtures/environment';
import { countRunRecords, stepOutput } from '../fixtures/flow-outcomes';
import { defineFlows, flowFixtures, type FlowDefinition } from '../fixtures/flows';
import { createIdentityTest, USER } from '../fixtures/identities';
import request, { setupRequest } from '../fixtures/request';
import { CreateCollection } from '../fixtures/schema';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

const test = createIdentityTest().extend(flowFixtures);
const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown> & { id: unknown };

function named(name: string): FlowDefinition {
	const flow = defineFlows('manual-and-subflow.json', manualJson).find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return flow;
}

const asAdmin = (api: Api) => `Bearer ${api.adminToken}`;

/** Creates a collection with an integer key and string fields, then seeds its rows. */
async function createCollection(api: Api, collection: string, fields: string[], rows: object[]): Promise<Row[]> {
	await CreateCollection(api, {
		collection,
		fields: fields.map((field) => ({ field, type: 'string', meta: {}, schema: {} })),
	});

	if (rows.length === 0) return [];

	const response = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.set('Authorization', asAdmin(api))
		.send(rows);

	return response.body.data;
}

async function grant(
	api: Api,
	role: string,
	collection: string,
	action: string,
	permissions: Record<string, unknown> = {}
) {
	await setupRequest(api.url)
		.post('/permissions')
		.set('Authorization', asAdmin(api))
		.send({ role, collection, action, fields: ['*'], permissions });
}

async function identity(api: Api, key: string): Promise<{ id: string; role: string; bearer: string }> {
	const row = await api.database('directus_users').where('email', USER[key]!.EMAIL).first('id', 'role');
	return { id: row.id, role: row.role, bearer: `Bearer ${USER[key]!.TOKEN}` };
}

/** Runs a manual flow, as the given bearer or anonymously. */
function runManual(api: Api, flow: FlowDefinition, body: Record<string, unknown>, bearer: string | null) {
	const pending = request(api.url).post(`/flows/trigger/${flow.id}`).send(body);
	return bearer === null ? pending : pending.set('Authorization', bearer);
}

test('a manual run needs read on the selected items and no flow read', async ({ api, flows }) => {
	const caller = await identity(api, 'API_ONLY');
	const [row] = await createCollection(api, 'test_flow_manual_selected', ['name'], [{ name: 'selected' }]);
	await grant(api, caller.role, 'test_flow_manual_selected', 'read');
	const flow = named('Manual selected');
	await flows.install([flow]);

	expect((await request(api.url).get(`/flows/${flow.id}`).set('Authorization', caller.bearer)).status).toBe(403);

	const response = await runManual(
		api,
		flow,
		{ collection: 'test_flow_manual_selected', keys: [row!.id] },
		caller.bearer
	);

	expect([response.status, response.body]).toEqual([200, { ran: true }]);
	expect(await countRunRecords(api.database, flow.id, { after: flows.baseline })).toEqual({ activity: 1, detail: 1 });
});

test('a manual run refuses unreadable items, an anonymous caller and a collection it is not enabled for', async ({
	api,
	flows,
}) => {
	const caller = await identity(api, 'API_ONLY');

	const [readable, hidden] = await createCollection(
		api,
		'test_flow_manual_refusals',
		['name', 'owner'],
		[
			{ name: 'readable', owner: 'readable' },
			{ name: 'hidden', owner: 'hidden' },
		]
	);

	const [outside] = await createCollection(api, 'test_flow_manual_outside', ['name'], [{ name: 'outside' }]);
	await grant(api, caller.role, 'test_flow_manual_refusals', 'read', { owner: { _eq: 'readable' } });
	await grant(api, PUBLIC_ROLE_ID, 'test_flow_manual_refusals', 'read', { owner: { _eq: 'readable' } });
	await grant(api, caller.role, 'test_flow_manual_outside', 'read');
	const flow = named('Manual refusals');
	await flows.install([flow]);
	const count = () => countRunRecords(api.database, flow.id, { after: flows.baseline });
	const refusals = 'test_flow_manual_refusals';

	const allowed = await runManual(api, flow, { collection: refusals, keys: [readable!.id] }, caller.bearer);

	expect([allowed.status, allowed.body]).toEqual([200, { ran: true }]);
	expect(await count()).toEqual({ activity: 1, detail: 1 });

	for (const [body, bearer] of [
		[{ collection: refusals, keys: [readable!.id, hidden!.id] }, caller.bearer],
		[{ collection: refusals, keys: [readable!.id] }, null],
		[{ collection: 'test_flow_manual_outside', keys: [outside!.id] }, caller.bearer],
	] as const) {
		const refused = await runManual(api, flow, body, bearer);

		expect(refused.status).toBe(403);
		expect(refused.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
	}

	expect(await count()).toEqual({ activity: 1, detail: 1 });
});

test('a flow read grant limits which flows a caller sees, not which flows the caller can run', async ({
	api,
	flows,
}) => {
	const mary = await identity(api, 'APP_ACCESS');
	const supervisor = await identity(api, 'API_ONLY');

	const [shared, other] = await createCollection(
		api,
		'test_flow_manual_appointments',
		['tenant', 'marker'],
		[
			{ tenant: 'shared', marker: 'shared' },
			{ tenant: 'other', marker: 'other' },
		]
	);

	const [customer] = await createCollection(api, 'test_flow_manual_customers', ['marker'], [{ marker: 'original' }]);
	const maryAction = named('Manual Mary action');
	const supervisorAction = named('Manual supervisor action');

	for (const [caller, own] of [
		[mary, maryAction],
		[supervisor, supervisorAction],
	] as const) {
		await grant(api, caller.role, 'test_flow_manual_appointments', 'read', { tenant: { _eq: 'shared' } });
		await grant(api, caller.role, 'directus_flows', 'read', { id: { _eq: own.id } });
	}

	await flows.install([maryAction, supervisorAction]);
	const customerId = customer!.id as number;

	const marker = async () =>
		(await api.database('test_flow_manual_customers').where('id', customerId).first('marker')).marker;

	const reset = () => api.database('test_flow_manual_customers').where('id', customerId).update({ marker: 'original' });

	for (const [caller, own] of [
		[mary, maryAction],
		[supervisor, supervisorAction],
	] as const) {
		const list = await request(api.url)
			.get('/flows')
			.query({ fields: '*,operations.*' })
			.set('Authorization', caller.bearer);

		expect(list.status).toBe(200);
		expect(list.body.data.map((flow: { id: string }) => flow.id)).toEqual([own.id]);
	}

	expect((await request(api.url).get(`/flows/${supervisorAction.id}`).set('Authorization', mary.bearer)).status).toBe(
		403
	);

	expect(
		(await request(api.url).get(`/flows/${supervisorAction.id}`).set('Authorization', supervisor.bearer)).status
	).toBe(200);

	const direct = await request(api.url)
		.patch(`/items/test_flow_manual_customers/${customer!.id}`)
		.set('Authorization', mary.bearer)
		.send({ marker: 'direct' });

	expect(direct.status).toBe(403);
	expect(await marker()).toBe('original');

	const runSupervisorAction = (key: unknown, value: string, bearer: string | null) =>
		runManual(
			api,
			supervisorAction,
			{ collection: 'test_flow_manual_appointments', keys: [key], customer: customer!.id, marker: value },
			bearer
		);

	const runs = async () => ({
		supervisor: await countRunRecords(api.database, supervisorAction.id, { after: flows.baseline }),
		mary: await countRunRecords(api.database, maryAction.id, { after: flows.baseline }),
	});

	for (const [index, [bearer, value]] of (
		[
			[supervisor.bearer, 'supervisor-run'],
			[mary.bearer, 'mary-run'],
		] as const
	).entries()) {
		await reset();

		expect((await runSupervisorAction(shared!.id, value, bearer)).status).toBe(200);
		expect(await marker()).toBe(value);

		expect(await runs()).toEqual({
			supervisor: { activity: index + 1, detail: index + 1 },
			mary: { activity: 0, detail: 0 },
		});
	}

	for (const [key, bearer] of [
		[other!.id, mary.bearer],
		[shared!.id, null],
	] as const) {
		await reset();
		const refused = await runSupervisorAction(key, 'refused-run', bearer);

		expect(refused.status).toBe(403);
		expect(refused.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
		expect(await marker()).toBe('original');

		expect(await runs()).toEqual({
			supervisor: { activity: 2, detail: 2 },
			mary: { activity: 0, detail: 0 },
		});
	}
});

test('a caller receives a selected result but not its source, definition or run record', async ({ api, flows }) => {
	const caller = await identity(api, 'APP_ACCESS');
	const [requested] = await createCollection(api, 'test_flow_manual_requests', ['name'], [{ name: 'request' }]);

	const [secret] = await createCollection(
		api,
		'test_flow_manual_secrets',
		['title', 'code'],
		[{ title: 'manual-visible-title', code: 'manual-hidden-code' }]
	);

	await grant(api, caller.role, 'test_flow_manual_requests', 'read');
	const flow = named('Manual selected result');
	await flows.install([flow]);
	const body = { collection: 'test_flow_manual_requests', keys: [requested!.id], secret: secret!.id };
	const readAs = (path: string) => request(api.url).get(path).set('Authorization', caller.bearer);

	const response = await runManual(api, flow, body, caller.bearer);

	expect([response.status, response.body]).toEqual([200, { title: 'manual-visible-title' }]);
	const [run] = await flows.runs(flow.id);

	expect(stepOutput(run!, 'read')).toMatchObject({ title: 'manual-visible-title', code: 'manual-hidden-code' });
	expect((await readAs(`/items/test_flow_manual_secrets/${secret!.id}`)).status).toBe(403);
	expect((await readAs(`/flows/${flow.id}`)).status).toBe(403);
	expect((await readAs(`/revisions/${run!.revision}`)).status).toBe(403);

	const own = await readAs(`/activity/${run!.activity}`);

	expect(own.status).toBe(200);
	expect(own.body.data.user).toBe(caller.id);

	expect((await runManual(api, flow, body, asAdmin(api))).status).toBe(200);
	const adminRun = (await flows.runs(flow.id)).at(-1);

	expect(adminRun!.activity).not.toBe(run!.activity);
	expect((await readAs(`/activity/${adminRun!.activity}`)).status).toBe(403);
});

test('with no selection required, a manual run needs a read permission on the collection', async ({ api, flows }) => {
	const reader = await identity(api, 'API_ONLY');
	const other = await identity(api, 'APP_ACCESS');
	await createCollection(api, 'test_flow_manual_collection', ['name'], []);
	await grant(api, reader.role, 'test_flow_manual_collection', 'read');
	const flow = named('Manual collection');
	await flows.install([flow]);
	const body = { collection: 'test_flow_manual_collection' };

	const permitted = await runManual(api, flow, body, reader.bearer);

	expect([permitted.status, permitted.body]).toEqual([200, { ran: true }]);
	expect((await runManual(api, flow, body, other.bearer)).status).toBe(403);
	expect(await countRunRecords(api.database, flow.id, { after: flows.baseline })).toEqual({ activity: 1, detail: 1 });
});

test("Trigger Flow passes its payload and returns the child's result", async ({ api, flows }) => {
	const parent = named('Subflow parent');
	const child = named('Subflow child');
	await flows.install([parent, child]);
	const value = randomUUID();

	const response = await request(api.url).get(`/flows/trigger/${parent.id}`).query({ value });

	expect([response.status, response.body]).toEqual([200, { received: value }]);
	flows.started(child.id);
	expect((await flows.finished(child.id)).map((run) => run.trigger)).toEqual([{ value }]);
});

test("serial, batch and parallel each return every child's result in input order", async ({ api, flows }) => {
	const child = named('Subflow iterate child');
	const parents = ['Subflow serial', 'Subflow batch', 'Subflow parallel'].map(named);
	await flows.install([...parents, child]);

	const inputs = [
		{ value: 'a', delay: 60 },
		{ value: 'b', delay: 30 },
		{ value: 'c', delay: 0 },
	];

	for (const [index, parent] of parents.entries()) {
		const response = await request(api.url).get(`/flows/trigger/${parent.id}`);

		expect([response.status, response.body]).toEqual([200, [{ received: 'a' }, { received: 'b' }, { received: 'c' }]]);
		flows.started(child.id, 3);
		const runs = await flows.finished(child.id);
		const latest = runs.slice(-3).map((run) => run.trigger);

		expect(runs).toHaveLength(3 * (index + 1));
		expect(latest).toHaveLength(3);
		expect(latest).toEqual(expect.arrayContaining(inputs));
	}
});

test("a child's From Trigger step uses the parent's caller", async ({ api, flows }) => {
	const first = await identity(api, 'APP_ACCESS');
	const second = await identity(api, 'API_ONLY');
	const me = await setupRequest(api.url).get('/users/me').set('Authorization', asAdmin(api));

	const seeded = await createCollection(
		api,
		'test_flow_subflow_identity',
		['name', 'owner'],
		[
			{ name: 'first', owner: first.id },
			{ name: 'second', owner: second.id },
			{ name: 'admin', owner: me.body.data.id },
		]
	);

	for (const caller of [first, second])
		await grant(api, caller.role, 'test_flow_subflow_identity', 'read', { owner: { _eq: '$CURRENT_USER' } });

	const parent = named('Subflow identity parent');
	const child = named('Subflow identity child');
	await flows.install([parent, child]);

	for (const caller of [first, second]) {
		const own = seeded.filter((row) => row['owner'] === caller.id);
		const response = await request(api.url).get(`/flows/trigger/${parent.id}`).set('Authorization', caller.bearer);

		expect([response.status, response.body]).toEqual([200, own]);
		flows.started(child.id);
		expect(stepOutput((await flows.finished(child.id)).at(-1)!, 'read')).toEqual(own);
	}
});
