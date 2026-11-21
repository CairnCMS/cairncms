import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import chainJson from '../fixtures/flows/chain.json';
import mixedJson from '../fixtures/flows/mixed-registry.json';
import rejoinJson from '../fixtures/flows/rejoin.json';
import unconnectedJson from '../fixtures/flows/unconnected.json';
import { readFinishedRuns, type FinishedRun } from '../fixtures/flow-outcomes';
import { defineFlows, flowTest as test, type FlowDefinition } from '../fixtures/flows';
import request from '../fixtures/request';
import { CreateCollection, CreateField } from '../fixtures/schema';
import type { Api } from '../fixtures/environment';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

/** The key and status of each step a run recorded, in the order the steps ran. */
function stepSequence(run: FinishedRun | undefined): { key: unknown; status: unknown }[] {
	if (!run) throw new Error('Expected a finished run');

	return run.steps.map((step) => {
		const { key, status } = step as { key?: unknown; status?: unknown };
		return { key, status };
	});
}

function single(definitions: FlowDefinition[]): FlowDefinition {
	if (definitions.length !== 1) throw new Error(`Expected one flow definition, found ${definitions.length}`);
	return definitions[0]!;
}

function named(definitions: FlowDefinition[], name: string): FlowDefinition {
	const flow = definitions.find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return flow;
}

async function runRejoin(api: Api, flow: FlowDefinition, after: number) {
	const results = [];

	for (const route of ['success', 'failure']) {
		const response = await request(api.url).get(`/flows/trigger/${flow.id}`).query({ route });
		const runs = await readFinishedRuns(api.database, flow.id, { after });
		results.push({ route, status: response.status, body: response.body, steps: stepSequence(runs.at(-1)) });
	}

	return results;
}

test('a 50-step chain passes its value through every step', async ({ api, flows }) => {
	const chain = single(defineFlows('chain.json', chainJson));
	await flows.install([chain]);
	const value = randomUUID();

	const response = await request(api.url).get(`/flows/trigger/${chain.id}`).query({ value });

	expect(response.status).toBe(200);
	expect(response.body).toEqual({ value });
	const runs = await readFinishedRuns(api.database, chain.id, { after: flows.baseline });
	expect(runs).toHaveLength(1);

	expect(stepSequence(runs[0])).toEqual(
		Array.from({ length: 50 }, (_, index) => ({ key: `step_${String(index + 1).padStart(2, '0')}`, status: 'resolve' }))
	);
});

test('a step reached from two branches runs once through the branch that ran', async ({ api, flows }) => {
	const rejoin = single(defineFlows('rejoin.json', rejoinJson));
	await flows.install([rejoin]);

	expect(await runRejoin(api, rejoin, flows.baseline)).toEqual([
		{
			route: 'success',
			status: 200,
			body: { shared: true },
			steps: [
				{ key: 'gate', status: 'resolve' },
				{ key: 'success_branch', status: 'resolve' },
				{ key: 'shared', status: 'resolve' },
			],
		},
		{
			route: 'failure',
			status: 200,
			body: { shared: true },
			steps: [
				{ key: 'gate', status: 'reject' },
				{ key: 'failure_branch', status: 'reject' },
				{ key: 'shared', status: 'resolve' },
			],
		},
	]);
});

test('a stored step that no path reaches never runs', async ({ api, flows }) => {
	const unconnected = single(defineFlows('unconnected.json', unconnectedJson));
	await flows.install([unconnected]);

	const response = await request(api.url).get(`/flows/trigger/${unconnected.id}`);

	expect(response.status).toBe(200);
	expect(response.body).toEqual({ answered: true });
	const runs = await readFinishedRuns(api.database, unconnected.id, { after: flows.baseline });
	expect(runs).toHaveLength(1);
	expect(stepSequence(runs[0])).toEqual([{ key: 'answer', status: 'resolve' }]);
	expect(runs[0]!.data).not.toHaveProperty('orphan');
});

test('moving steps does not change results', async ({ api, flows }) => {
	const rejoin = single(defineFlows('rejoin.json', rejoinJson));
	await flows.install([rejoin]);
	const before = await runRejoin(api, rejoin, flows.baseline);

	const moved = single(defineFlows('rejoin.json', rejoinJson));

	for (const operation of moved.operations) {
		operation.position_x += 200;
		operation.position_y += 100;
	}

	await flows.install([moved]);
	const after = await runRejoin(api, moved, flows.baseline);

	expect(after).toEqual(before);
	expect(before.map((result) => result.status)).toEqual([200, 200]);
});

test('every trigger type runs after one readiness wait, and again after a definition change', async ({
	api,
	flows,
}) => {
	const collection = 'test_flow_graph_events';
	await CreateCollection(api, { collection });
	await CreateField(api, { collection, field: 'name', type: 'string' });

	const definitions = [...defineFlows('mixed-registry.json', mixedJson), ...defineFlows('rejoin.json', rejoinJson)];
	const webhook = named(definitions, 'Mixed webhook');
	const manual = named(definitions, 'Mixed manual');
	const filter = named(definitions, 'Mixed filter');
	const action = named(definitions, 'Mixed action');
	const child = named(definitions, 'Mixed child');
	const parent = named(definitions, 'Mixed parent');
	const rejoin = named(definitions, 'Graph rejoin');
	const admin = `Bearer ${api.adminToken}`;

	const versions = async (flowId: string) =>
		(await readFinishedRuns(api.database, flowId, { after: flows.baseline })).map((run) => run.data['version']);

	for (const [index, version] of ['v1', 'v2'].entries()) {
		for (const flow of definitions)
			for (const operation of flow.operations)
				if (operation.key === 'version') operation.options = { json: { version } };

		await flows.install(definitions);
		const recorded = ['v1', 'v2'].slice(0, index + 1).map((value) => ({ version: value }));

		const hook = await request(api.url).get(`/flows/trigger/${webhook.id}`);
		expect([hook.status, hook.body]).toEqual([200, { version }]);

		const button = await request(api.url)
			.post(`/flows/trigger/${manual.id}`)
			.set('Authorization', admin)
			.send({ collection });

		expect([button.status, button.body]).toEqual([200, { version }]);

		const call = await request(api.url).get(`/flows/trigger/${parent.id}`);
		flows.started(child.id);
		expect([call.status, call.body]).toEqual([200, { parent: version, child: version }]);
		expect(await versions(parent.id)).toEqual(recorded);

		const created = await request(api.url)
			.post(`/items/${collection}`)
			.set('Authorization', admin)
			.send({ name: version });

		flows.started(action.id);
		expect(created.status).toBe(200);
		expect(await versions(filter.id)).toEqual(recorded);

		const shared = await request(api.url).get(`/flows/trigger/${rejoin.id}`).query({ route: 'success' });
		expect([shared.status, shared.body]).toEqual([200, { shared: true }]);

		expect((await flows.finished(action.id)).map((run) => run.data['version'])).toEqual(recorded);
		expect((await flows.finished(child.id)).map((run) => run.data['version'])).toEqual(recorded);
	}
});
