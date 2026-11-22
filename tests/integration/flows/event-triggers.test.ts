import { expect } from 'vitest';
import eventsJson from '../fixtures/flows/events.json';
import type { Api } from '../fixtures/environment';
import { stepOutput, type RunView } from '../fixtures/flow-outcomes';
import { defineFlows, flowFixtures, type FlowDefinition } from '../fixtures/flows';
import { createIdentityTest, USER } from '../fixtures/identities';
import request, { setupRequest } from '../fixtures/request';
import { CreateCollection } from '../fixtures/schema';
import { initializeFixtures } from '../harness/fixture-setup.mjs';
import { sleep } from '../utils/sleep';

initializeFixtures();

const test = createIdentityTest().extend(flowFixtures);

function named(name: string): FlowDefinition {
	const flow = defineFlows('events.json', eventsJson).find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return flow;
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
async function logContains(api: Api, marker: string): Promise<boolean> {
	const deadline = performance.now() + 5000;

	while (performance.now() < deadline) {
		if ((await api.readLogs()).includes(marker)) return true;
		await sleep(25);
	}

	return false;
}

const asAdmin = (api: Api) => `Bearer ${api.adminToken}`;

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
