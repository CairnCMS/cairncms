import { expect } from 'vitest';
import boundariesJson from '../fixtures/flows/event-boundaries.json';
import eventsJson from '../fixtures/flows/events.json';
import type { Api } from '../fixtures/environment';
import { countRunRecords, stepOutput, type RunView } from '../fixtures/flow-outcomes';
import { defineFlows, flowFixtures, type FlowDefinition } from '../fixtures/flows';
import { createIdentityTest, USER } from '../fixtures/identities';
import request, { setupRequest } from '../fixtures/request';
import { CreateCollection } from '../fixtures/schema';
import { initializeFixtures } from '../harness/fixture-setup.mjs';
import { sleep } from '../utils/sleep';

initializeFixtures();

const test = createIdentityTest({ hookFixtures: ['flow-emit-receipt'] }).extend(flowFixtures);

function named(name: string, status: FlowDefinition['status'] = 'active'): FlowDefinition {
	const definitions = [
		...defineFlows('events.json', eventsJson),
		...defineFlows('event-boundaries.json', boundariesJson),
	];

	const flow = definitions.find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return { ...flow, status };
}

/** Creates a collection with an integer key and the given string fields. */
async function createCollection(api: Api, collection: string, fields: string[] = ['name']): Promise<void> {
	await CreateCollection(api, {
		collection,
		fields: fields.map((field) => ({ field, type: 'string', meta: {}, schema: {} })),
	});
}

const storedRows = (api: Api, collection: string): Promise<Record<string, unknown>[]> =>
	api.database(collection).select('id', 'name').orderBy('id');

const trigger = (run: RunView) => run.trigger as Record<string, unknown>;

/** Polls the file API's log for a marker, because a line can reach the file after the response that caused it. */
async function logContains(api: Api, marker: string | RegExp): Promise<boolean> {
	const deadline = performance.now() + 5000;

	while (performance.now() < deadline) {
		const logs = await api.readLogs();
		if (typeof marker === 'string' ? logs.includes(marker) : marker.test(logs)) return true;
		await sleep(25);
	}

	return false;
}

const asAdmin = (api: Api) => `Bearer ${api.adminToken}`;

/** Grants a role an action on a collection, and returns the permission's id. */
async function grantPermission(
	api: Api,
	role: string,
	collection: string,
	action: string,
	fields: string[] = ['*']
): Promise<unknown> {
	const response = await setupRequest(api.url)
		.post('/permissions')
		.set('Authorization', asAdmin(api))
		.send({ role, collection, action, fields, permissions: {} });

	return response.body.data.id;
}

async function roleOf(api: Api, user: string): Promise<string> {
	const row = await api.database('directus_users').where('email', USER[user]!.EMAIL).first('role');
	return row.role;
}

test('an after-event flow receives the submitted fields and key, and sees the saved row', async ({ api, flows }) => {
	const flow = named('Event after read');
	await createCollection(api, 'test_flow_events_read');
	await flows.install([flow]);

	const created = await request(api.url)
		.post('/items/test_flow_events_read')
		.set('Authorization', asAdmin(api))
		.send({ name: 'saved' });

	expect(created.status).toBe(200);
	const id = created.body.data.id;
	flows.started(flow.id);
	const [run] = await flows.finished(flow.id);

	expect(trigger(run!)['payload']).toEqual({ name: 'saved' });
	expect(trigger(run!)['key']).toBe(id);
	expect(stepOutput(run!, 'read')).toMatchObject({ id, name: 'saved' });
});

test('creating three items in one request starts three runs', async ({ api, flows }) => {
	const flow = named('Event after batch');
	await createCollection(api, 'test_flow_events_batch');
	await flows.install([flow]);

	const created = await request(api.url)
		.post('/items/test_flow_events_batch')
		.set('Authorization', asAdmin(api))
		.send([{ name: 'first' }, { name: 'second' }, { name: 'third' }]);

	expect(created.status).toBe(200);
	flows.started(flow.id, 3);
	const runs = await flows.finished(flow.id);
	const stored = new Map((await storedRows(api, 'test_flow_events_batch')).map((row) => [row['id'], row['name']]));

	expect(new Set(runs.map((run) => trigger(run)['key']))).toEqual(new Set(stored.keys()));

	for (const run of runs) {
		const payload = trigger(run)['payload'] as Record<string, unknown>;
		expect(Object.keys(payload)).toEqual(['name']);
		expect(stored.get(trigger(run)['key'])).toBe(payload['name']);
	}
});

test('a keys-and-data update of three keys starts one run with all three keys', async ({ api, flows }) => {
	const flow = named('Event after update');
	await createCollection(api, 'test_flow_events_update', ['name', 'note']);

	const seeded = await setupRequest(api.url)
		.post('/items/test_flow_events_update')
		.set('Authorization', asAdmin(api))
		.send([
			{ name: 'first', note: 'kept' },
			{ name: 'second', note: 'kept' },
			{ name: 'third', note: 'kept' },
		]);

	const keys = (seeded.body.data as { id: unknown }[]).map((row) => row.id);
	await flows.install([flow]);

	const updated = await request(api.url)
		.patch('/items/test_flow_events_update')
		.set('Authorization', asAdmin(api))
		.send({ keys, data: { name: 'updated' } });

	expect(updated.status).toBe(200);
	flows.started(flow.id);
	const runs = await flows.finished(flow.id);

	expect(runs).toHaveLength(1);
	expect(trigger(runs[0]!)['keys']).toEqual(keys);
	expect(trigger(runs[0]!)['payload']).toEqual({ name: 'updated' });

	expect(await api.database('test_flow_events_update').select('name', 'note').orderBy('id')).toEqual(
		keys.map(() => ({ name: 'updated', note: 'kept' }))
	);
});

test('a blocking create can replace the saved payload', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_replace');
	await flows.install([named('Event replace')]);

	const created = await request(api.url)
		.post('/items/test_flow_events_replace')
		.set('Authorization', asAdmin(api))
		.send({ name: 'original' });

	expect(created.status).toBe(200);
	expect(await storedRows(api, 'test_flow_events_replace')).toEqual([{ id: created.body.data.id, name: 'replaced' }]);
});

test('a blocking create refused by a Condition creates no row and leaks no detail', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_condition', ['name', 'refusal_marker']);
	await flows.install([named('Event condition refusal')]);

	const create = (marker: string) =>
		request(api.url)
			.post('/items/test_flow_events_condition')
			.set('Authorization', asAdmin(api))
			.send({ name: marker, refusal_marker: marker });

	const refused = await create('denied');

	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(await storedRows(api, 'test_flow_events_condition')).toEqual([]);
	expect(refused.text.includes(JSON.stringify(['$trigger', 'payload', 'refusal_marker']))).toBe(false);
	expect(refused.text.includes('any.only')).toBe(false);

	const allowed = await create('allowed');

	expect(allowed.status).toBe(200);
	expect((await storedRows(api, 'test_flow_events_condition')).map((row) => row['name'])).toEqual(['allowed']);
});

test('a blocking create whose last step is refused by permissions returns its code', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_source');
	await createCollection(api, 'test_flow_events_target');
	const { role } = await api.database('directus_users').where('email', USER['API_ONLY']!.EMAIL).first('role');

	const grant = (collection: string) =>
		setupRequest(api.url)
			.post('/permissions')
			.set('Authorization', asAdmin(api))
			.send({ role, collection, action: 'create', fields: ['*'] });

	await grant('test_flow_events_source');
	await flows.install([named('Event forbidden')]);
	const caller = `Bearer ${USER['API_ONLY']!.TOKEN}`;

	const create = () =>
		request(api.url).post('/items/test_flow_events_source').set('Authorization', caller).send({ name: 'copied' });

	const refused = await create();

	expect(refused.status).toBe(403);
	expect(refused.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
	expect(await storedRows(api, 'test_flow_events_source')).toEqual([]);
	expect(await storedRows(api, 'test_flow_events_target')).toEqual([]);

	await grant('test_flow_events_target');
	const allowed = await create();

	expect(allowed.status).toBeLessThan(300);
	expect((await storedRows(api, 'test_flow_events_source')).map((row) => row['name'])).toEqual(['copied']);
	expect((await storedRows(api, 'test_flow_events_target')).map((row) => row['name'])).toEqual(['copied']);
});

test('a blocking update refused by a Run Script throw leaves the row unchanged', async ({ api, flows }) => {
	const flow = named('Event script refusal');
	await createCollection(api, 'test_flow_events_script');

	const seeded = await setupRequest(api.url)
		.post('/items/test_flow_events_script')
		.set('Authorization', asAdmin(api))
		.send({ name: 'original' });

	const id = seeded.body.data.id;
	await flows.install([flow]);

	const refused = await request(api.url)
		.patch(`/items/test_flow_events_script/${id}`)
		.set('Authorization', asAdmin(api))
		.send({ name: 'changed' });

	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(await storedRows(api, 'test_flow_events_script')).toEqual([{ id, name: 'original' }]);
	expect(await logContains(api, 'flow-event-script-reached-throw')).toBe(true);
	const runs = await flows.runs(flow.id);
	expect(runs).toHaveLength(1);
	expect(runs[0]).toMatchObject({ outcome: 'refused', reason: 'STEP_FAILED' });
});

test("a list update starts one run per item with that item's changes", async ({ api, flows }) => {
	const flow = named('Event list update');
	await createCollection(api, 'test_flow_events_list');

	const seeded = await setupRequest(api.url)
		.post('/items/test_flow_events_list')
		.set('Authorization', asAdmin(api))
		.send([{ name: 'first' }, { name: 'second' }, { name: 'third' }]);

	const changes = (seeded.body.data as { id: unknown }[]).map((row, index) => ({
		id: row.id,
		name: `changed ${index}`,
	}));

	await flows.install([flow]);

	const updated = await request(api.url)
		.patch('/items/test_flow_events_list')
		.set('Authorization', asAdmin(api))
		.send(changes);

	expect(updated.status).toBe(200);
	flows.started(flow.id, 3);
	const runs = await flows.finished(flow.id);
	const received = runs.map((run) => ({ keys: trigger(run)['keys'], payload: trigger(run)['payload'] }));

	expect(received).toHaveLength(3);
	expect(received).toEqual(expect.arrayContaining(changes.map(({ id, name }) => ({ keys: [id], payload: { name } }))));
});

test("a refused blocking create rolls back the flow's own write", async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_rollback');
	await createCollection(api, 'test_flow_events_rollback_side');
	await flows.install([named('Event rollback')]);

	const create = (name: string) =>
		request(api.url).post('/items/test_flow_events_rollback').set('Authorization', asAdmin(api)).send({ name });

	const refused = await create('denied');

	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(await logContains(api, /flow-event-rollback-created denied \[\d+\]/)).toBe(true);
	expect(await storedRows(api, 'test_flow_events_rollback')).toEqual([]);
	expect(await storedRows(api, 'test_flow_events_rollback_side')).toEqual([]);

	const allowed = await create('allowed');

	expect(allowed.status).toBe(200);
	expect((await storedRows(api, 'test_flow_events_rollback')).map((row) => row['name'])).toEqual(['allowed']);
	expect((await storedRows(api, 'test_flow_events_rollback_side')).map((row) => row['name'])).toEqual(['allowed']);
});

test('a refused item in a batch create rolls back the items before it', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_batch_rollback');
	await flows.install([named('Event batch rollback')]);

	const created = await request(api.url)
		.post('/items/test_flow_events_batch_rollback')
		.set('Authorization', asAdmin(api))
		.send([{ name: 'first' }, { name: 'second' }, { name: 'third' }]);

	expect(created.status).toBeGreaterThanOrEqual(400);
	expect(await logContains(api, 'flow-event-batch-read second [{"name":"first"}]')).toBe(true);
	expect(await storedRows(api, 'test_flow_events_batch_rollback')).toEqual([]);
});

test("a blocking replacement is checked against the caller's field permissions", async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_fields', ['name', 'secret']);

	const permission = await grantPermission(api, await roleOf(api, 'API_ONLY'), 'test_flow_events_fields', 'create', [
		'name',
	]);

	await flows.install([named('Event replaced fields')]);
	const stored = () => api.database('test_flow_events_fields').select('name', 'secret');

	const create = () =>
		request(api.url)
			.post('/items/test_flow_events_fields')
			.set('Authorization', `Bearer ${USER['API_ONLY']!.TOKEN}`)
			.send({ name: 'kept' });

	const refused = await create();

	expect(refused.status).toBe(403);
	expect(refused.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
	expect(await stored()).toEqual([]);

	await setupRequest(api.url)
		.patch(`/permissions/${permission}`)
		.set('Authorization', asAdmin(api))
		.send({ fields: ['name', 'secret'] });

	const allowed = await create();

	expect(allowed.status).toBeLessThan(300);
	expect(await stored()).toEqual([{ name: 'kept', secret: 'injected' }]);
});

test('an appointment update reaches the customer only through an elevated step', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_customers', ['name', 'next_appointment']);
	await createCollection(api, 'test_flow_events_appointments', ['starts_at', 'customer']);
	const role = await roleOf(api, 'APP_ACCESS');
	await grantPermission(api, role, 'test_flow_events_appointments', 'read');
	await grantPermission(api, role, 'test_flow_events_appointments', 'update', ['starts_at']);
	await grantPermission(api, role, 'test_flow_events_customers', 'read');

	const customer = (
		await setupRequest(api.url)
			.post('/items/test_flow_events_customers')
			.set('Authorization', asAdmin(api))
			.send({ name: 'Ada', next_appointment: null })
	).body.data;

	const appointment = (
		await setupRequest(api.url)
			.post('/items/test_flow_events_appointments')
			.set('Authorization', asAdmin(api))
			.send({ starts_at: '2026-11-01', customer: String(customer.id) })
	).body.data;

	const mary = `Bearer ${USER['APP_ACCESS']!.TOKEN}`;
	const customers = () => api.database('test_flow_events_customers').select('id', 'next_appointment');

	const reschedule = (startsAt: string) =>
		request(api.url)
			.patch(`/items/test_flow_events_appointments/${appointment.id}`)
			.set('Authorization', mary)
			.send({ starts_at: startsAt });

	const updateCustomerDirectly = () =>
		request(api.url)
			.patch(`/items/test_flow_events_customers/${customer.id}`)
			.set('Authorization', mary)
			.send({ next_appointment: 'direct' });

	/** Checks that the run received only the submitted patch and the appointment's key, and that its read found it. */
	const expectEvent = (run: RunView, startsAt: string) => {
		expect(trigger(run)['payload']).toEqual({ starts_at: startsAt });
		expect(trigger(run)['keys']).toEqual([String(appointment.id)]);

		expect(stepOutput(run, 'read')).toMatchObject({
			id: appointment.id,
			starts_at: startsAt,
			customer: String(customer.id),
		});
	};

	const asTrigger = named('Event Mary trigger');
	await flows.install([asTrigger]);

	expect((await reschedule('2026-12-01')).status).toBe(200);
	flows.started(asTrigger.id);
	const [refused] = await flows.finished(asTrigger.id);

	expectEvent(refused!, '2026-12-01');

	expect(refused!.steps).toEqual([
		{ key: 'read', path: 'success' },
		{ key: 'update', path: 'failure' },
	]);

	expect(refused).toMatchObject({ outcome: 'failed', reason: 'STEP_FAILED' });
	expect(refused!.last).toMatchObject({ code: 'FORBIDDEN' });
	expect((await updateCustomerDirectly()).status).toBe(403);
	expect(await customers()).toEqual([{ id: customer.id, next_appointment: null }]);

	const asFull = named('Event Mary full');
	await flows.install([named('Event Mary trigger', 'inactive'), asFull]);

	expect((await reschedule('2026-12-15')).status).toBe(200);
	flows.started(asFull.id);
	const [allowed] = await flows.finished(asFull.id);

	expectEvent(allowed!, '2026-12-15');

	expect(allowed!.steps).toEqual([
		{ key: 'read', path: 'success' },
		{ key: 'update', path: 'success' },
	]);

	expect(allowed).toMatchObject({ outcome: 'completed', reason: null });
	expect((await updateCustomerDirectly()).status).toBe(403);
	expect(await customers()).toEqual([{ id: customer.id, next_appointment: '2026-12-15' }]);
});

test('deactivated blocking and webhook flows stop until reactivated', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_deactivate');

	const stage = async (status: FlowDefinition['status']) => {
		const webhook = named('Event deactivate webhook', status);
		await flows.install([named('Event deactivate filter', status), webhook]);

		const created = await request(api.url)
			.post('/items/test_flow_events_deactivate')
			.set('Authorization', asAdmin(api))
			.send({ name: 'denied' });

		const answered = await request(api.url).get(`/flows/trigger/${webhook.id}`);

		return {
			stored: created.status < 300,
			webhook: answered.status,
			answer: answered.status === 200 ? answered.body : null,
			rows: (await storedRows(api, 'test_flow_events_deactivate')).length,
		};
	};

	expect(await stage('active')).toEqual({ stored: false, webhook: 200, answer: { active: true }, rows: 0 });
	expect(await stage('inactive')).toEqual({ stored: true, webhook: 403, answer: null, rows: 1 });
	expect(await stage('active')).toEqual({ stored: false, webhook: 200, answer: { active: true }, rows: 1 });
});

test('a blocking delete refusal keeps the row, and a delete action receives the keys', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_delete');

	const seeded = await setupRequest(api.url)
		.post('/items/test_flow_events_delete')
		.set('Authorization', asAdmin(api))
		.send({ name: 'target' });

	const id = seeded.body.data.id;
	const action = named('Event delete action');
	await flows.install([named('Event delete filter'), action]);

	const remove = (agent: string) =>
		request(api.url)
			.delete(`/items/test_flow_events_delete/${id}`)
			.set('Authorization', asAdmin(api))
			.set('User-Agent', agent);

	const refused = await remove('flow-delete-refused');

	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(await storedRows(api, 'test_flow_events_delete')).toEqual([{ id, name: 'target' }]);

	await flows.install([named('Event delete filter', 'inactive')]);
	const removed = await remove('flow-delete-allowed');

	expect(removed.status).toBeLessThan(300);
	expect(await storedRows(api, 'test_flow_events_delete')).toEqual([]);
	flows.started(action.id);
	const [run] = await flows.finished(action.id);

	expect(trigger(run!)).toMatchObject({ keys: [String(id)], collection: 'test_flow_events_delete' });
	expect(run!.accountability).toMatchObject({ userAgent: 'flow-delete-allowed' });
});

test("Emit Events starts event flows with the writing step's identity, and off starts none", async ({ api, flows }) => {
	await createCollection(api, 'test_flow_events_emitted');
	const on = named('Event emit on');
	const off = named('Event emit off');
	const action = named('Event emitted action');
	const witness = named('Event emitted witness');
	await flows.install([on, off, action, witness]);
	const system = { user: null, role: null, admin: true };

	expect((await request(api.url).get(`/flows/trigger/${off.id}`)).status).toBe(200);

	expect(await countRunRecords(api.database, witness.id, { after: flows.baseline })).toEqual({
		activity: 0,
		detail: 0,
	});

	expect((await request(api.url).get(`/flows/trigger/${on.id}`)).status).toBe(200);
	expect(await logContains(api, 'flow-emit-receipt on')).toBe(true);
	expect((await api.readLogs()).includes('flow-emit-receipt off')).toBe(false);

	const witnessed = await flows.runs(witness.id);

	expect(witnessed).toHaveLength(1);
	expect(witnessed[0]!.accountability).toMatchObject(system);

	flows.started(action.id);
	const [run] = await flows.finished(action.id);

	expect(trigger(run!)['payload']).toEqual({ name: 'on' });
	expect(run!.accountability).toMatchObject(system);
	expect((await storedRows(api, 'test_flow_events_emitted')).map((row) => row['name'])).toEqual(['off', 'on']);
});
