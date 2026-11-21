/* eslint-disable no-console */
import { afterAll, expect } from 'vitest';
import type { Knex } from 'knex';
import { flowTest as test, SENTINEL_FLOW, type FlowDefinition } from '../../fixtures/flows';
import { readFinishedRuns } from '../../fixtures/flow-outcomes';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const mode = process.env.CONTROL_FLOW_CLEANUP;

const SYNC_FLOW = '2d6c1f0e-4b3a-4c9d-8e7f-1a2b3c4d5e6f';
const SYNC_FIRST = '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SYNC_SECOND = '4b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const ASYNC_FLOW = '7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b';
const ASYNC_FIRST = '8f9a0b1c-2d3e-4f4a-8b5c-6d7e8f9a0b1c';
const ASYNC_SECOND = '9a0b1c2d-3e4f-4a5b-9c6d-7e8f9a0b1c2d';

/** A two-step webhook flow whose first step links to a second step that returns `{ finished: true }`. */
function webhookFlow(
	ids: { flow: string; first: string; second: string },
	options: Record<string, unknown>,
	first: { type: string; options: Record<string, unknown> }
): FlowDefinition {
	return {
		id: ids.flow,
		name: `Control flow ${ids.flow}`,
		icon: null,
		color: null,
		description: null,
		status: 'active',
		trigger: 'webhook',
		accountability: options['async'] ? 'all' : null,
		options: { method: 'GET', cacheEnabled: false, ...options },
		operation: ids.first,
		operations: [
			{
				id: ids.first,
				name: null,
				key: 'first',
				type: first.type,
				position_x: 1,
				position_y: 1,
				options: first.options,
				resolve: ids.second,
				reject: null,
			},
			{
				id: ids.second,
				name: null,
				key: 'second',
				type: 'transform',
				position_x: 20,
				position_y: 1,
				options: { json: { finished: true } },
				resolve: null,
				reject: null,
			},
		],
	};
}

const syncFlow = webhookFlow(
	{ flow: SYNC_FLOW, first: SYNC_FIRST, second: SYNC_SECOND },
	{},
	{ type: 'transform', options: { json: { value: 'sync' } } }
);

const asyncFlow = (milliseconds: number, async: unknown = true) =>
	webhookFlow(
		{ flow: ASYNC_FLOW, first: ASYNC_FIRST, second: ASYNC_SECOND },
		{ async },
		{ type: 'sleep', options: { milliseconds } }
	);

let snapshot: { database: Knex; ids: string[]; rows: string } | undefined;

/** Serializes the stored rows that cleanup must leave untouched when it stops the API. */
async function storedRows(database: Knex, ids: string[]): Promise<string> {
	const flows = await database('directus_flows')
		.whereIn('id', ids)
		.orderBy('id')
		.select('id', 'status', 'trigger', 'accountability', 'operation', 'options');

	const operations = await database('directus_operations')
		.whereIn('flow', ids)
		.orderBy('id')
		.select('id', 'flow', 'key', 'type', 'options', 'resolve', 'reject');

	return JSON.stringify({ flows, operations });
}

async function takeSnapshot(database: Knex, flowId: string): Promise<void> {
	const ids = [flowId, SENTINEL_FLOW];
	snapshot = { database, ids, rows: await storedRows(database, ids) };
}

afterAll(async () => {
	if (!snapshot) return;
	const unchanged = (await storedRows(snapshot.database, snapshot.ids)) === snapshot.rows;
	console.log(`CONTROL_FLOW_ROWS_UNCHANGED=${unchanged}`);
});

if (mode === 'clean') {
	test('first case cleans up after its runs finish', async ({ api, flows }) => {
		await flows.install([syncFlow, asyncFlow(500)]);

		const sync = await request(api.url).get(`/flows/trigger/${SYNC_FLOW}`);
		expect(sync.status).toBe(200);
		expect(sync.body).toEqual({ finished: true });

		const started = await request(api.url).get(`/flows/trigger/${ASYNC_FLOW}`).query({ marker: 'A' });
		expect(started.status).toBeLessThan(300);
		flows.started(ASYNC_FLOW);

		const runs = await flows.finished(ASYNC_FLOW);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.data).toMatchObject({ $trigger: { query: { marker: 'A' } } });
	});

	test('second case counts only its own runs', async ({ api, flows }) => {
		console.log('CONTROL_FLOW_DEPENDENT_BODY');

		expect((await request(api.url).get(`/flows/trigger/${SYNC_FLOW}`)).status).toBe(403);
		expect((await request(api.url).get(`/flows/trigger/${ASYNC_FLOW}`)).status).toBe(403);

		await flows.install([syncFlow, asyncFlow(500)]);

		expect((await readFinishedRuns(api.database, ASYNC_FLOW)).length).toBeGreaterThan(0);
		expect(await readFinishedRuns(api.database, ASYNC_FLOW, { after: flows.baseline })).toEqual([]);

		expect((await request(api.url).get(`/flows/trigger/${SYNC_FLOW}`)).status).toBe(200);
		const started = await request(api.url).get(`/flows/trigger/${ASYNC_FLOW}`).query({ marker: 'B' });
		expect(started.status).toBeLessThan(300);
		flows.started(ASYNC_FLOW);

		const runs = await flows.finished(ASYNC_FLOW);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.activity).toBeGreaterThan(flows.baseline);
		expect(runs[0]!.data).toMatchObject({ $trigger: { query: { marker: 'B' } } });
	});
} else {
	test('first case leaves the registry uncertain', async ({ api, flows }) => {
		if (mode === 'readiness') {
			await api.database('directus_flows').where('id', SENTINEL_FLOW).update({ status: 'inactive' });

			let failure: unknown;

			try {
				await flows.install([syncFlow]);
			} catch (error) {
				failure = error;
			}

			await takeSnapshot(api.database, SYNC_FLOW);
			throw failure ?? new Error('CONTROL_FLOW_READINESS_DID_NOT_FAIL');
		}

		if (mode === 'unfinished' || mode === 'truthy-async') {
			await flows.install([asyncFlow(60000, mode === 'truthy-async' ? 'true' : true)]);
			expect((await request(api.url).get(`/flows/trigger/${ASYNC_FLOW}`)).status).toBeLessThan(300);
			flows.started(ASYNC_FLOW);
			await takeSnapshot(api.database, ASYNC_FLOW);
			return;
		}

		if (mode === 'cleanup-error') {
			await flows.install([asyncFlow(0)]);
			expect((await request(api.url).get(`/flows/trigger/${ASYNC_FLOW}`)).status).toBeLessThan(300);
			flows.started(ASYNC_FLOW);
			const [run] = await flows.finished(ASYNC_FLOW);
			await api.database('directus_revisions').where('id', run!.revision).update({ data: 'not json' });
			await takeSnapshot(api.database, ASYNC_FLOW);
			return;
		}

		if (mode === 'failure') {
			await flows.install([syncFlow]);
			expect((await request(api.url).get(`/flows/trigger/${SYNC_FLOW}`)).status).toBe(200);
			await takeSnapshot(api.database, SYNC_FLOW);
			throw new Error('CONTROL_FLOW_ASSERTION');
		}

		throw new Error(`Unknown CONTROL_FLOW_CLEANUP mode: ${mode}`);
	});

	test('second case is blocked', async ({ flows }) => {
		void flows;
		console.log('CONTROL_FLOW_DEPENDENT_BODY');
	});
}
