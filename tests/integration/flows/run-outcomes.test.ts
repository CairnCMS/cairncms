import { expect } from 'vitest';
import outcomesJson from '../fixtures/flows/outcomes.json';
import responsesJson from '../fixtures/flows/responses.json';
import trackingJson from '../fixtures/flows/tracking.json';
import type { Api } from '../fixtures/environment';
import { countRunRecords, readFinishedRuns, stepOutput, type RunView } from '../fixtures/flow-outcomes';
import { defineFlows, flowTest as test, type FlowDefinition, type FlowFixture } from '../fixtures/flows';
import request from '../fixtures/request';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

function named(definitions: FlowDefinition[], name: string): FlowDefinition {
	const flow = definitions.find((definition) => definition.name === name);
	if (!flow) throw new Error(`No flow definition named ${name}`);
	return flow;
}

/** Runs one outcome fixture and returns its single finished run. */
async function runOnce(api: Api, flows: FlowFixture, flow: FlowDefinition): Promise<RunView> {
	await request(api.url).get(`/flows/trigger/${flow.id}`);
	const runs = await flows.runs(flow.id);
	expect(runs).toHaveLength(1);
	return runs[0]!;
}

test('tracking settings decide what is recorded', async ({ api, flows }) => {
	const definitions = defineFlows('tracking.json', trackingJson);
	await flows.install(definitions);

	for (const flow of definitions) {
		const response = await request(api.url).get(`/flows/trigger/${flow.id}`);
		expect([response.status, response.body]).toEqual([200, { second: true }]);
	}

	const counts = (name: string) =>
		countRunRecords(api.database, named(definitions, name).id, { after: flows.baseline });

	expect(await counts('Tracking all')).toEqual({ activity: 1, detail: 1 });
	expect(await counts('Tracking activity')).toEqual({ activity: 1, detail: 0 });
	expect(await counts('Tracking none')).toEqual({ activity: 0, detail: 0 });

	const [run] = await flows.runs(named(definitions, 'Tracking all').id);

	expect(run!.steps).toEqual([
		{ key: 'first', path: 'success' },
		{ key: 'second', path: 'success' },
	]);
});

test('the authorization header is not stored', async ({ api, flows }) => {
	const flow = named(defineFlows('tracking.json', trackingJson), 'Tracking all');
	await flows.install([flow]);
	const header = `Bearer ${api.adminToken}`;

	const response = await request(api.url).get(`/flows/trigger/${flow.id}`).set('Authorization', header);
	expect(response.status).toBe(200);

	const runs = await readFinishedRuns(api.database, flow.id, { after: flows.baseline });
	expect(runs).toHaveLength(1);
	const trigger = runs[0]!.data['$trigger'] as { headers?: Record<string, unknown> } | undefined;

	// Compared as booleans so that a failing assertion cannot print the token.
	expect(trigger?.headers?.['authorization'] !== header).toBe(true);
	expect(JSON.stringify(runs[0]).includes(api.adminToken)).toBe(false);
});

test('a run that ends on success is completed', async ({ api, flows }) => {
	const flow = named(defineFlows('outcomes.json', outcomesJson), 'Outcome success');
	await flows.install([flow]);
	const run = await runOnce(api, flows, flow);
	expect(run).toMatchObject({ outcome: 'completed', reason: null });
});

test('a false Condition with no next step is completed', async ({ api, flows }) => {
	const flow = named(defineFlows('outcomes.json', outcomesJson), 'Outcome condition false');
	await flows.install([flow]);
	const run = await runOnce(api, flows, flow);
	expect(run).toMatchObject({ outcome: 'completed', reason: 'CONDITION_FALSE' });
});

test('a Condition whose rule cannot be evaluated has failed', async ({ api, flows }) => {
	const flow = named(defineFlows('outcomes.json', outcomesJson), 'Outcome condition error');
	await flows.install([flow]);
	const run = await runOnce(api, flows, flow);
	expect(run).toMatchObject({ outcome: 'failed', reason: 'CONDITION_ERROR' });
});

test('a failure whose failure path is followed is completed', async ({ api, flows }) => {
	const flow = named(defineFlows('outcomes.json', outcomesJson), 'Outcome failure path');
	await flows.install([flow]);
	const run = await runOnce(api, flows, flow);

	expect(run).toMatchObject({ outcome: 'completed', reason: null });

	expect(run.steps).toEqual([
		{ key: 'broken', path: 'failure' },
		{ key: 'recover', path: 'success' },
	]);

	expect(stepOutput(run, 'broken')).toEqual({ message: expect.any(String) });
});

test('a failure with no failure path has failed', async ({ api, flows }) => {
	const flow = named(defineFlows('outcomes.json', outcomesJson), 'Outcome step failed');
	await flows.install([flow]);
	const run = await runOnce(api, flows, flow);
	expect(run).toMatchObject({ outcome: 'failed', reason: 'STEP_FAILED' });
});

test('the response setting selects the result', async ({ api, flows }) => {
	const definitions = defineFlows('responses.json', responsesJson);
	await flows.install(definitions);
	const respond = (name: string) => request(api.url).get(`/flows/trigger/${named(definitions, name).id}`);

	const last = await respond('Response last');
	expect([last.status, last.body]).toEqual([200, { b: 2 }]);

	const all = await respond('Response all').query({ marker: 'whole-chain' });
	expect(all.status).toBe(200);

	expect(all.body).toMatchObject({
		first: { a: 1 },
		second: { b: 2 },
		$last: { b: 2 },
		$trigger: { query: { marker: 'whole-chain' } },
	});

	const step = await respond('Response step');
	expect([step.status, step.body]).toEqual([200, { a: 1 }]);
});
