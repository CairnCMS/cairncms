import { expect } from 'vitest';
import identityJson from '../fixtures/flows/identity.json';
import type { Api } from '../fixtures/environment';
import { stepOutput, type RunView } from '../fixtures/flow-outcomes';
import { defineFlows, flowFixtures, type FlowDefinition, type FlowFixture } from '../fixtures/flows';
import { createIdentityTest, USER } from '../fixtures/identities';
import request, { setupRequest } from '../fixtures/request';
import { CreateCollection } from '../fixtures/schema';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

const test = createIdentityTest().extend(flowFixtures);
const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';
const CURRENT_USER = { owner: { _eq: '$CURRENT_USER' } };

type Row = { id: unknown; name: unknown; owner: unknown };

function named(name: string): FlowDefinition {
	const flow = defineFlows('identity.json', identityJson).find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return flow;
}

/** Creates a collection with an integer key and string `name` and `owner` fields, then seeds its rows. */
async function createCollection(api: Api, collection: string, rows: Omit<Row, 'id'>[]): Promise<Row[]> {
	await CreateCollection(api, {
		collection,
		fields: ['name', 'owner'].map((field) => ({ field, type: 'string', meta: {}, schema: {} })),
	});

	const response = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send(rows);

	return response.body.data;
}

async function grantRead(api: Api, role: string, collection: string, filter: Record<string, unknown> = {}) {
	await setupRequest(api.url)
		.post('/permissions')
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send({ role, collection, action: 'read', fields: ['*'], permissions: filter });
}

async function identity(api: Api, key: string): Promise<{ id: string; role: string; token: string }> {
	const row = await api.database('directus_users').where('email', USER[key]!.EMAIL).first('id', 'role');
	return { id: row.id, role: row.role, token: USER[key]!.TOKEN };
}

const storedRows = (api: Api, collection: string): Promise<Row[]> =>
	api.database(collection).select('id', 'name', 'owner').orderBy('id');

/** Calls a webhook flow, as the given bearer token or anonymously. */
function call(api: Api, flow: FlowDefinition, token: string | null, query: Record<string, unknown> = {}) {
	const pending = request(api.url).get(`/flows/trigger/${flow.id}`).query(query);
	return token === null ? pending : pending.set('Authorization', `Bearer ${token}`);
}

async function newestRun(flows: FlowFixture, flow: FlowDefinition): Promise<RunView> {
	const run = (await flows.runs(flow.id)).at(-1);
	if (!run) throw new Error(`Flow ${flow.name} has no finished run`);
	return run;
}

test('From Trigger refuses a write the caller may not make', async ({ api, flows }) => {
	const caller = await identity(api, 'APP_ACCESS');
	const [row] = await createCollection(api, 'test_flow_identity_refuse', [{ name: 'original', owner: 'any' }]);
	await grantRead(api, caller.role, 'test_flow_identity_refuse');
	const flow = named('Identity update trigger');
	await flows.install([flow]);

	await call(api, flow, caller.token, { id: row!.id });

	expect(await storedRows(api, 'test_flow_identity_refuse')).toEqual([row]);
	const run = await newestRun(flows, flow);
	expect(run).toMatchObject({ outcome: 'failed', reason: 'STEP_FAILED' });
	expect(run.last).toMatchObject({ code: 'FORBIDDEN' });
});

test('Full Access performs the write for the same caller', async ({ api, flows }) => {
	const caller = await identity(api, 'APP_ACCESS');
	const [row] = await createCollection(api, 'test_flow_identity_full', [{ name: 'original', owner: 'any' }]);
	await grantRead(api, caller.role, 'test_flow_identity_full');
	const flow = named('Identity update full');
	await flows.install([flow]);

	const response = await call(api, flow, caller.token, { id: row!.id });

	expect(response.status).toBe(200);
	expect(await storedRows(api, 'test_flow_identity_full')).toEqual([{ ...row, name: 'changed' }]);
});

test('a specific role reaches only its own rows', async ({ api, flows }) => {
	const { role } = await identity(api, 'API_ONLY');

	const seeded = await createCollection(api, 'test_flow_identity_role', [
		{ name: 'first', owner: 'role' },
		{ name: 'second', owner: 'other' },
		{ name: 'third', owner: 'role' },
		{ name: 'fourth', owner: 'other' },
	]);

	await grantRead(api, role, 'test_flow_identity_role', { owner: { _eq: 'role' } });
	const flow = named('Identity read role');
	flow.operations[0]!.options['permissions'] = role;
	await flows.install([flow]);
	const allowed = seeded.filter((row) => row.owner === 'role');

	const response = await call(api, flow, api.adminToken);

	expect([response.status, response.body]).toEqual([200, allowed]);
	expect(stepOutput(await newestRun(flows, flow), 'read')).toEqual(allowed);
});

test('Public Role uses public access, and so does an anonymous From Trigger caller', async ({ api, flows }) => {
	const seeded = await createCollection(api, 'test_flow_identity_public', [
		{ name: 'first', owner: 'public' },
		{ name: 'second', owner: 'private' },
		{ name: 'third', owner: 'public' },
		{ name: 'fourth', owner: 'private' },
	]);

	await grantRead(api, PUBLIC_ROLE_ID, 'test_flow_identity_public', { owner: { _eq: 'public' } });
	const asPublic = named('Identity read public');
	const asTrigger = named('Identity read trigger');
	await flows.install([asPublic, asTrigger]);
	const allowed = seeded.filter((row) => row.owner === 'public');

	const fromAdmin = await call(api, asPublic, api.adminToken);
	expect([fromAdmin.status, fromAdmin.body]).toEqual([200, allowed]);
	expect(stepOutput(await newestRun(flows, asPublic), 'read')).toEqual(allowed);

	const fromAnonymous = await call(api, asTrigger, null);
	expect([fromAnonymous.status, fromAnonymous.body]).toEqual([200, allowed]);
	expect(stepOutput(await newestRun(flows, asTrigger), 'read')).toEqual(allowed);
});

test('two callers of one From Trigger flow each reach only their own rows', async ({ api, flows }) => {
	const first = await identity(api, 'APP_ACCESS');
	const second = await identity(api, 'API_ONLY');

	const me = await setupRequest(api.url).get('/users/me').set('Authorization', `Bearer ${api.adminToken}`);

	const seeded = await createCollection(api, 'test_flow_identity_own', [
		{ name: 'first', owner: first.id },
		{ name: 'second', owner: second.id },
		{ name: 'admin', owner: me.body.data.id },
	]);

	await grantRead(api, first.role, 'test_flow_identity_own', CURRENT_USER);
	await grantRead(api, second.role, 'test_flow_identity_own', CURRENT_USER);
	const flow = named('Identity read own');
	await flows.install([flow]);

	for (const caller of [first, second]) {
		const own = seeded.filter((row) => row.owner === caller.id);
		const response = await call(api, flow, caller.token);

		expect([response.status, response.body]).toEqual([200, own]);
		expect(stepOutput(await newestRun(flows, flow), 'read')).toEqual(own);
	}
});

test('one flow can mix identities, and Full Access ends with its step', async ({ api, flows }) => {
	const caller = await identity(api, 'APP_ACCESS');
	const other = await identity(api, 'API_ONLY');

	const [mine, theirs] = await createCollection(api, 'test_flow_identity_mixed', [
		{ name: 'mine', owner: caller.id },
		{ name: 'theirs', owner: other.id },
	]);

	await grantRead(api, caller.role, 'test_flow_identity_mixed', CURRENT_USER);
	const flow = named('Identity mixed');
	await flows.install([flow]);

	const response = await call(api, flow, caller.token, { other: theirs!.id });

	expect([response.status, response.body]).toEqual([200, [mine]]);
	const run = await newestRun(flows, flow);
	expect(stepOutput(run, 'read')).toEqual([mine]);
	expect(stepOutput(run, 'read_after')).toEqual([mine]);

	expect(await storedRows(api, 'test_flow_identity_mixed')).toEqual([
		mine,
		{ ...theirs, name: 'updated by full access' },
	]);
});
