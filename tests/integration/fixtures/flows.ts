/* eslint-disable no-console */
import type { Fixtures } from '@vitest/runner';
import type { FlowRaw, OperationRaw } from '@cairncms/types';
import type { Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { createApiTest, type Api } from './environment';
import { readActivityBaseline, readFinishedRuns, type FinishedRun } from './flow-outcomes';
import request, { setupRequest } from './request';
import { sleep } from '../utils/sleep';

export type OperationDefinition = Omit<OperationRaw, 'flow' | 'date_created' | 'user_created'>;

export type FlowDefinition = Omit<FlowRaw, 'operations' | 'date_created' | 'user_created'> & {
	operations: OperationDefinition[];
};

export type FlowFixture = {
	/** Highest activity id when the case began. Only run records above it belong to the case. */
	readonly baseline: number;
	/** Stores the definitions, then waits until the API has loaded them. */
	install: (definitions: FlowDefinition[]) => Promise<void>;
	/** Records that the case started background runs of an installed flow. */
	started: (flowId: string, count?: number) => void;
	/** Waits until every declared run of a background flow has its final record, and returns those runs. */
	finished: (flowId: string) => Promise<FinishedRun[]>;
};

export const SENTINEL_FLOW = '6f1d3c2a-8b4e-4f7a-9c1d-2e5b8a7f0c31';

const SENTINEL_STEP = '0b9e7d4c-3a2f-4e1b-8d6c-5f4a3b2c1d0e';
const READY_DEADLINE_MS = 5000;
const FINISHED_DEADLINE_MS = 10000;
const POLL_INTERVAL_MS = 25;

/** The webhook whose returned marker shows which stored definitions the API has loaded. */
function sentinelDefinition(marker: string): FlowDefinition {
	return {
		id: SENTINEL_FLOW,
		name: 'Flow fixture sentinel',
		icon: null,
		color: null,
		description: null,
		status: 'active',
		trigger: 'webhook',
		accountability: null,
		options: { method: 'GET', cacheEnabled: false },
		operation: SENTINEL_STEP,
		operations: [
			{
				id: SENTINEL_STEP,
				name: null,
				key: 'sentinel',
				type: 'transform',
				position_x: 1,
				position_y: 1,
				options: { json: { marker } },
				resolve: null,
				reject: null,
			},
		],
	};
}

/** Whether a flow can still be running after the request or event that started it has returned. */
function runsInBackground(flow: FlowDefinition): boolean {
	if (flow.trigger === 'event') return flow.options?.['type'] !== 'filter';
	if (flow.trigger === 'webhook' || flow.trigger === 'manual') return Boolean(flow.options?.['async']);
	return flow.trigger === 'operation';
}

function validate(flow: FlowDefinition): void {
	if (flow.id === SENTINEL_FLOW) throw new Error('The flow fixture owns the sentinel definition');
	if (flow.trigger === 'schedule')
		throw new Error(`Flow ${flow.id} uses a schedule, which the flow fixture does not install`);

	if (runsInBackground(flow) && flow.accountability !== 'all')
		throw new Error(`Flow ${flow.id} can run in the background, so it must record full run detail`);

	const steps = new Set(flow.operations.map((operation) => operation.id));

	for (const target of [
		flow.operation,
		...flow.operations.flatMap((operation) => [operation.resolve, operation.reject]),
	])
		if (target !== null && !steps.has(target)) throw new Error(`Flow ${flow.id} links to missing step ${target}`);
}

/** Inserts flows, then their steps, then the links between steps, then each flow's entry step. */
async function seedFlows(trx: Knex.Transaction, definitions: FlowDefinition[]): Promise<void> {
	await trx('directus_flows').insert(
		definitions.map((flow) => ({
			id: flow.id,
			name: flow.name,
			icon: flow.icon,
			color: flow.color,
			description: flow.description,
			status: flow.status,
			trigger: flow.trigger,
			accountability: flow.accountability,
			options: JSON.stringify(flow.options ?? {}),
			operation: null,
		}))
	);

	const operations = definitions.flatMap((flow) => flow.operations.map((operation) => ({ flow, operation })));

	if (operations.length > 0)
		await trx('directus_operations').insert(
			operations.map(({ flow, operation }) => ({
				id: operation.id,
				name: operation.name,
				key: operation.key,
				type: operation.type,
				position_x: operation.position_x,
				position_y: operation.position_y,
				options: JSON.stringify(operation.options ?? {}),
				resolve: null,
				reject: null,
				flow: flow.id,
			}))
		);

	for (const { operation } of operations)
		if (operation.resolve !== null || operation.reject !== null)
			await trx('directus_operations')
				.where('id', operation.id)
				.update({ resolve: operation.resolve, reject: operation.reject });

	for (const flow of definitions)
		if (flow.operation !== null) await trx('directus_flows').where('id', flow.id).update({ operation: flow.operation });
}

/** Clears the links between steps and the entry steps before deleting, so the cascade never meets a live reference. */
async function removeFlows(trx: Knex.Transaction, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await trx('directus_operations').whereIn('flow', ids).update({ resolve: null, reject: null });
	await trx('directus_flows').whereIn('id', ids).update({ operation: null });
	await trx('directus_flows').whereIn('id', ids).del();
}

/** Polls the sentinel until it returns the marker, which only a reload of the current definitions can register. */
async function waitForMarker(api: Api, marker: string): Promise<void> {
	const deadline = performance.now() + READY_DEADLINE_MS;
	let last: Response | undefined;
	let cause: unknown;

	try {
		while (performance.now() < deadline) {
			last = await request(api.url)
				.get(`/flows/trigger/${SENTINEL_FLOW}`)
				.timeout({ deadline: Math.max(1, deadline - performance.now()) });

			if (last.status === 200 && last.body?.marker === marker) return;
			if (![200, 403].includes(last.status)) break;
			await sleep(POLL_INTERVAL_MS);
		}
	} catch (error) {
		cause = error;
	}

	throw new Error(
		`The flow registry did not become ready: ${JSON.stringify({
			status: last?.status,
			body: last?.body,
			error: cause instanceof Error ? cause.message : cause,
		})}`,
		{ cause }
	);
}

/** Changes the sentinel's marker through one API save, which queues exactly one reload, then waits for it. */
async function reloadRegistry(api: Api): Promise<void> {
	const marker = randomUUID();

	await setupRequest(api.url)
		.patch(`/operations/${SENTINEL_STEP}`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send({ options: { json: { marker } } });

	await waitForMarker(api, marker);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const flowFixtures: Fixtures<{ flows: FlowFixture }, { api: Api; available: void }> = {
	flows: async ({ api, available, task, onTestFinished }, use) => {
		void available;

		const installed = new Set<string>();
		const background = new Set<string>();
		const declared = new Map<string, number>();
		let uncertain: string | undefined;
		let stopped: Error | undefined;

		onTestFinished(() => {
			if (stopped) throw stopped;
		});

		if (!(await api.database('directus_flows').where('id', SENTINEL_FLOW).first()))
			await api.database.transaction((trx) => seedFlows(trx, [sentinelDefinition(randomUUID())]));

		const baseline = await readActivityBaseline(api.database);

		const fixture: FlowFixture = {
			baseline,
			async install(definitions) {
				if (uncertain) throw new Error(`The flow registry is uncertain: ${uncertain}`);
				for (const flow of definitions) validate(flow);

				try {
					await api.database.transaction(async (trx) => {
						await removeFlows(
							trx,
							definitions.map((flow) => flow.id)
						);

						await seedFlows(trx, definitions);
					});

					for (const flow of definitions) {
						installed.add(flow.id);
						if (runsInBackground(flow)) background.add(flow.id);
					}

					await reloadRegistry(api);
				} catch (error) {
					uncertain = `installing flows failed: ${describe(error)}`;
					throw error;
				}
			},
			started(flowId, count = 1) {
				if (!background.has(flowId)) throw new Error(`Flow ${flowId} is not an installed background flow`);
				declared.set(flowId, (declared.get(flowId) ?? 0) + count);
			},
			async finished(flowId) {
				const expected = declared.get(flowId) ?? 0;
				if (expected === 0) throw new Error(`No runs of flow ${flowId} were declared as started`);
				const deadline = performance.now() + FINISHED_DEADLINE_MS;

				for (;;) {
					const runs = await readFinishedRuns(api.database, flowId, { after: baseline });

					if (runs.length > expected)
						throw new Error(`Flow ${flowId} finished ${runs.length} runs, but the case declared ${expected}`);

					if (runs.length === expected) return runs;

					if (performance.now() >= deadline)
						throw new Error(`Flow ${flowId} finished ${runs.length} of ${expected} declared runs`);

					await sleep(POLL_INTERVAL_MS);
				}
			},
		};

		await use(fixture);

		const reasons: string[] = [];
		if (uncertain) reasons.push(uncertain);
		if (task.result?.state === 'fail') reasons.push('the case failed');

		if (reasons.length === 0) {
			try {
				for (const flowId of background) {
					const runs = await readFinishedRuns(api.database, flowId, { after: baseline });
					const expected = declared.get(flowId) ?? 0;
					if (runs.length !== expected)
						reasons.push(`flow ${flowId} finished ${runs.length} of ${expected} declared runs`);
				}
			} catch (error) {
				reasons.push(`reading run records failed: ${describe(error)}`);
			}
		}

		if (reasons.length === 0 && installed.size > 0) {
			try {
				await api.database.transaction((trx) => removeFlows(trx, [...installed]));
				await reloadRegistry(api);
			} catch (error) {
				reasons.push(`cleanup failed: ${describe(error)}`);
			}
		}

		if (reasons.length === 0) return;

		console.error(`Flow fixture stopped the API after "${task.name}": ${reasons.join(', ')}`);
		stopped = new Error(`Flow fixture stopped the API: ${reasons.join(', ')}`);

		try {
			if (api.available()) await api.stop(api.child);
		} catch (error) {
			stopped = new Error(`${stopped.message}, and stopping it failed: ${describe(error)}`, { cause: error });
		}
	},
};

export const flowTest = createApiTest().extend(flowFixtures);
