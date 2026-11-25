import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import optionsJson from '../fixtures/flows/stored-options.json';
import type { Api } from '../fixtures/environment';
import { countRunRecords, stepOutput } from '../fixtures/flow-outcomes';
import { defineFlows, flowFixtures, type FlowDefinition } from '../fixtures/flows';
import { createIdentityTest, USER } from '../fixtures/identities';
import request, { setupRequest } from '../fixtures/request';
import { CreateCollection } from '../fixtures/schema';
import { initializeFixtures } from '../harness/fixture-setup.mjs';
import { sleep } from '../utils/sleep';

initializeFixtures();

const test = createIdentityTest({
	extensions: ['cairncms-extension-flow-operation'],
	hookFixtures: ['flow-update-receipt'],
}).extend(flowFixtures);

type Row = Record<string, unknown> & { id: number };

function named(name: string): FlowDefinition {
	const flow = defineFlows('stored-options.json', optionsJson).find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return flow;
}

const asAdmin = (api: Api) => `Bearer ${api.adminToken}`;

/** Creates a collection with an integer key and string fields, then seeds its rows. */
async function createCollection(
	api: Api,
	collection: string,
	rows: object[],
	fields: string[] = ['name']
): Promise<Row[]> {
	await CreateCollection(api, {
		collection,
		fields: fields.map((field) => ({ field, type: 'string', meta: {}, schema: {} })),
	});

	const response = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.set('Authorization', asAdmin(api))
		.send(rows);

	return response.body.data;
}

async function identity(api: Api, key: string): Promise<{ id: string; role: string; bearer: string }> {
	const row = await api.database('directus_users').where('email', USER[key]!.EMAIL).first('id', 'role');
	return { id: row.id, role: row.role, bearer: `Bearer ${USER[key]!.TOKEN}` };
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

/** Calls a webhook flow, as the given bearer or anonymously. */
function call(api: Api, flow: FlowDefinition, query: Record<string, unknown> = {}, bearer: string | null = null) {
	const pending = request(api.url).get(`/flows/trigger/${flow.id}`).query(query);
	return bearer === null ? pending : pending.set('Authorization', bearer);
}

/** Polls the file API's log, from `from` onward, for a marker, because a line can reach the file after its response. */
async function logContains(api: Api, marker: string, from = 0): Promise<boolean> {
	const deadline = performance.now() + 5000;

	while (performance.now() < deadline) {
		if ((await api.readLogs()).slice(from).includes(marker)) return true;
		await sleep(25);
	}

	return false;
}

test('record keys stored as a list, a comma-separated string or a single value reach the same records', async ({
	api,
	flows,
}) => {
	const [first, , third] = await createCollection(api, 'test_flow_options_keys', [
		{ name: 'first' },
		{ name: 'second' },
		{ name: 'third' },
	]);

	const flow = named('Options key shapes');

	const keys: Record<string, unknown> = {
		as_list: [String(first!.id), String(third!.id)],
		as_text: `${first!.id},${third!.id}`,
		as_single: String(third!.id),
		as_one_item_list: [String(third!.id)],
	};

	for (const operation of flow.operations) operation.options = { ...operation.options, key: keys[operation.key] };
	await flows.install([flow]);

	expect((await call(api, flow)).status).toBe(200);
	const [run] = await flows.runs(flow.id);

	for (const key of ['as_list', 'as_text']) {
		const rows = stepOutput(run!, key) as Row[];

		expect(rows).toHaveLength(2);
		expect(rows).toEqual(expect.arrayContaining([first, third]));
	}

	expect(stepOutput(run!, 'as_single')).toEqual(third);
	expect(stepOutput(run!, 'as_one_item_list')).toEqual(third);
});

test('a whole-value reference keeps its type, and an embedded reference becomes text', async ({ api, flows }) => {
	const flow = named('Options references');
	await flows.install([flow]);

	const response = await call(api, flow);

	expect([response.status, response.body]).toEqual([
		200,
		{ whole_number: 3, whole_object: { a: 1 }, embedded_number: 'count 3', embedded_object: 'nested {"a":1}' },
	]);

	const [run] = await flows.runs(flow.id);

	expect(stepOutput(run!, 'whole')).toEqual({ a: 1 });
});

test('a step saved the way Studio saves it acts as From Trigger, returns one record for one key and emits no events', async ({
	api,
	flows,
}) => {
	const caller = await identity(api, 'APP_ACCESS');
	const [row] = await createCollection(api, 'test_flow_options_studio', [{ name: 'original' }]);
	await grant(api, caller.role, 'test_flow_options_studio', 'read');
	const flow = named('Options Studio shape');
	const witness = named('Options Studio witness');
	await flows.install([flow, witness]);
	const stored = () => api.database('test_flow_options_studio').select('id', 'name');

	await call(api, flow, { id: row!.id }, caller.bearer);
	const refused = (await flows.runs(flow.id)).at(-1)!;

	expect(stepOutput(refused, 'load')).toEqual(row);

	expect(refused.steps).toEqual([
		{ key: 'load', path: 'success' },
		{ key: 'save', path: 'failure' },
	]);

	expect(refused).toMatchObject({ outcome: 'failed', reason: 'STEP_FAILED' });
	expect(refused.last).toMatchObject({ code: 'FORBIDDEN' });
	expect(await stored()).toEqual([row]);

	await grant(api, caller.role, 'test_flow_options_studio', 'update');

	expect((await call(api, flow, { id: row!.id }, caller.bearer)).status).toBe(200);
	const allowed = (await flows.runs(flow.id)).at(-1)!;

	expect(stepOutput(allowed, 'save')).toEqual(row!.id);
	expect(await stored()).toEqual([{ ...row, name: 'studio-saved' }]);

	expect(await countRunRecords(api.database, witness.id, { after: flows.baseline })).toEqual({
		activity: 0,
		detail: 0,
	});

	const patched = await setupRequest(api.url)
		.patch(`/items/test_flow_options_studio/${row!.id}`)
		.set('Authorization', asAdmin(api))
		.send({ name: 'direct-patch' });

	expect(patched.status).toBe(200);

	expect(await countRunRecords(api.database, witness.id, { after: flows.baseline })).toEqual({
		activity: 1,
		detail: 1,
	});

	expect(await logContains(api, 'flow-update-receipt direct-patch')).toBe(true);
	expect((await api.readLogs()).includes('flow-update-receipt studio-saved')).toBe(false);
});

test('a missing record and an unreadable record give the caller the same error', async ({ api, flows }) => {
	const caller = await identity(api, 'APP_ACCESS');

	const [visible, hidden] = await createCollection(api, 'test_flow_options_hidden', [
		{ name: 'visible' },
		{ name: 'hidden' },
	]);

	await grant(api, caller.role, 'test_flow_options_hidden', 'read', { name: { _eq: 'visible' } });
	const flow = named('Options missing or hidden');
	await flows.install([flow]);

	const readable = await call(api, flow, { id: visible!.id }, caller.bearer);

	expect([readable.status, readable.body]).toEqual([200, visible]);

	const unreadable = await call(api, flow, { id: hidden!.id }, caller.bearer);
	expect(await api.database('test_flow_options_hidden').where('id', hidden!.id).del()).toBe(1);
	const missing = await call(api, flow, { id: hidden!.id }, caller.bearer);

	expect([missing.status, missing.body, missing.text]).toEqual([unreadable.status, unreadable.body, unreadable.text]);
	const [, hiddenRun, missingRun] = await flows.runs(flow.id);

	expect(missingRun!.last).toEqual(hiddenRun!.last);
	expect(hiddenRun!.last).toMatchObject({ code: 'FORBIDDEN' });
});

test('a step can read a collection named by trigger data', async ({ api, flows }) => {
	await createCollection(api, 'test_flow_options_alpha', [{ name: 'alpha' }]);
	await createCollection(api, 'test_flow_options_beta', [{ name: 'beta' }]);
	const flow = named('Options dynamic collection');
	await flows.install([flow]);

	for (const name of ['alpha', 'beta']) {
		const response = await call(api, flow, { collection: `test_flow_options_${name}` });

		expect([response.status, response.body]).toEqual([200, [{ name }]]);
	}
});

test('Run Script returns a value into the chain, sees no unlisted environment variable and keeps the token out of its console output', async ({
	api,
	flows,
}) => {
	const flow = named('Options script');
	await flows.install([flow]);
	const nonce = randomUUID();
	const from = (await api.readLogs()).length;

	const response = await call(api, flow, { n: 21, nonce }, asAdmin(api));

	expect([response.status, response.body]).toEqual([200, { doubled: 42 }]);
	const [run] = await flows.runs(flow.id);

	expect(stepOutput(run!, 'script')).toMatchObject({ sees_secret: false });
	expect(await logContains(api, `flow-console-complete-${nonce}`, from)).toBe(true);

	// Compared as a boolean so that a failing assertion cannot print the token.
	expect((await api.readLogs()).slice(from).includes(api.adminToken)).toBe(false);
});

test('a Run Script throw follows the failure path', async ({ api, flows }) => {
	const flow = named('Options script failure');
	await flows.install([flow]);

	const response = await call(api, flow);

	expect([response.status, response.body]).toEqual([200, { recovered: true }]);
	const [run] = await flows.runs(flow.id);

	expect(run!.steps).toEqual([
		{ key: 'throw', path: 'failure' },
		{ key: 'recover', path: 'success' },
	]);

	expect(await logContains(api, 'flow-options-script-reached-throw')).toBe(true);
});

test('an operation extension receives its resolved options, the data chain, the caller and the platform context', async ({
	api,
	flows,
}) => {
	const caller = await identity(api, 'APP_ACCESS');
	const flow = named('Options extension');
	await flows.install([flow]);
	const marker = randomUUID();

	const response = await call(api, flow, { name: 'ada', marker }, caller.bearer);

	expect([response.status, response.body]).toEqual([200, { echoed: 'hello ada' }]);
	const [run] = await flows.runs(flow.id);
	const probe = stepOutput(run!, 'probe') as { chain: string[] };

	expect(probe).toMatchObject({
		options: { greeting: 'hello ada' },
		synthetic: marker,
		user: caller.id,
		context: { services: true, database: true, getSchema: true, env: true, logger: true },
	});

	expect(probe.chain).toEqual(expect.arrayContaining(['$trigger', '$last', '$accountability', '$env', 'seed']));
});

test('an operation extension throw follows the failure path', async ({ api, flows }) => {
	const flow = named('Options extension failure');
	await flows.install([flow]);

	const response = await call(api, flow);

	expect([response.status, response.body]).toEqual([200, { recovered: true }]);
	const [run] = await flows.runs(flow.id);

	expect(run!.steps).toEqual([
		{ key: 'probe', path: 'failure' },
		{ key: 'recover', path: 'success' },
	]);

	expect(await logContains(api, 'flow-probe-reached-throw')).toBe(true);
});
