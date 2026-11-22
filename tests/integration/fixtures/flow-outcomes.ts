import type { Knex } from 'knex';

export const RUN_STATUSES = ['queued', 'running'] as const;
export const RUN_OUTCOMES = ['completed', 'failed', 'refused', 'not_admitted', 'unknown'] as const;

export const RUN_REASONS = [
	'CAPACITY',
	'OWNER_STOPPED',
	'CONDITION_FALSE',
	'CONDITION_ERROR',
	'STEP_FAILED',
	'STEP_UNAVAILABLE',
] as const;

export const STEP_PATHS = ['success', 'failure', 'unavailable'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type RunReason = (typeof RUN_REASONS)[number];
export type RunClassification = { outcome: RunOutcome; reason: RunReason | null };
export type StepPath = (typeof STEP_PATHS)[number];
export type RunStep = { key: string; path: StepPath };

/** A finished run as the suites check it, independent of how the run record is stored. */
export type RunView = {
	flow: string;
	activity: number;
	revision: number;
	steps: RunStep[];
	outputs: ReadonlyMap<string, unknown>;
	trigger: unknown;
	last: unknown;
	accountability: unknown;
	outcome: RunOutcome;
	reason: RunReason | null;
};

export type FinishedRun = {
	flow: string;
	activity: number;
	revision: number;
	steps: unknown[];
	data: Record<string, unknown>;
};

type RunRow = { activity: number | string; revision: number | string; data: unknown };
type StoredStatus = 'resolve' | 'reject' | 'unknown';
type StoredStep = { operation: unknown; key: string; status: StoredStatus; options: unknown };

const AMBIGUOUS_STEP_MESSAGE = 'the operation could not be resolved';
const RESERVED_KEYS: ReadonlySet<string> = new Set(['$trigger', '$accountability', '$last', '$env']);
const PATHS: Record<StoredStatus, StepPath> = { resolve: 'success', reject: 'failure', unknown: 'unavailable' };

/** Reads the finished runs of a flow whose activity rows are above `after`, oldest first. */
export async function readFinishedRuns(
	database: Knex,
	flowId: string,
	{ after = 0 }: { after?: number } = {}
): Promise<FinishedRun[]> {
	const rows: RunRow[] = await runActivity(database, flowId, after)
		.join('directus_revisions', 'directus_revisions.activity', 'directus_activity.id')
		.orderBy('directus_activity.id')
		.select('directus_activity.id as activity', 'directus_revisions.id as revision', 'directus_revisions.data');

	return rows.map((row) => toFinishedRun(flowId, row));
}

/**
 * Reads the finished runs of a flow above `after` as views, oldest first. Each run is classified against the flow's
 * current rows, so `after` must exclude runs of any earlier definition.
 */
export async function readRuns(
	database: Knex,
	flowId: string,
	{ after = 0 }: { after?: number } = {}
): Promise<RunView[]> {
	const views: RunView[] = [];
	for (const run of await readFinishedRuns(database, flowId, { after })) views.push(await toRunView(database, run));
	return views;
}

/** Returns the output of the one step with this key that ran, and throws when none or several did. */
export function stepOutput(run: RunView, key: string): unknown {
	const count = run.steps.filter((step) => step.key === key).length;
	if (count === 0) throw new Error(`Run record ${run.revision} of flow ${run.flow} has no step with key ${key}`);

	if (count > 1)
		throw new Error(
			`Run record ${run.revision} of flow ${run.flow} has ${count} steps with key ${key}, so its output is ambiguous`
		);

	return run.outputs.get(key);
}

/** Counts a flow's run activity rows above `after`, and how many of them have a detail record. */
export async function countRunRecords(
	database: Knex,
	flowId: string,
	{ after = 0 }: { after?: number } = {}
): Promise<{ activity: number; detail: number }> {
	const rows: { activity: number | string; revision: number | string | null }[] = await runActivity(
		database,
		flowId,
		after
	)
		.leftJoin('directus_revisions', 'directus_revisions.activity', 'directus_activity.id')
		.select('directus_activity.id as activity', 'directus_revisions.id as revision');

	return {
		activity: new Set(rows.map((row) => Number(row.activity))).size,
		detail: new Set(rows.filter((row) => row.revision !== null).map((row) => Number(row.activity))).size,
	};
}

/** Reads the highest activity id, which marks where a case's own run records begin. */
export async function readActivityBaseline(database: Knex): Promise<number> {
	const row = await database('directus_activity').max('id as id').first();
	return Number(row?.id ?? 0);
}

/** Validates a stored run's steps and data chain, classifies it, and builds its view. */
async function toRunView(database: Knex, run: FinishedRun): Promise<RunView> {
	const unrecognized = (reason: string) =>
		new Error(`Run record ${run.revision} of flow ${run.flow} cannot be read: ${reason}`);

	const steps: StoredStep[] = run.steps.map((step, index) => {
		if (!isRecord(step)) throw unrecognized(`step ${index} is not an object`);
		const { operation, key, status, options } = step;
		if (typeof key !== 'string') throw unrecognized(`step ${index} has no key`);
		if (!isStoredStatus(status)) throw unrecognized(`step ${index} has status ${JSON.stringify(status)}`);
		return { operation, key, status, options };
	});

	const keys = new Set(steps.map((step) => step.key));
	const stored = Object.keys(run.data);

	for (const key of stored)
		if (!RESERVED_KEYS.has(key) && !keys.has(key))
			throw unrecognized(`its data chain holds ${key}, which no recorded step wrote`);

	for (const key of ['$trigger', '$last', '$accountability', ...keys])
		if (!stored.includes(key)) throw unrecognized(`its data chain has no ${key} entry`);

	const { outcome, reason } = await classifyRun(database, run, steps);

	return {
		flow: run.flow,
		activity: run.activity,
		revision: run.revision,
		steps: steps.map(({ key, status }) => ({ key, path: PATHS[status] })),
		outputs: new Map(Object.entries(run.data).filter(([key]) => keys.has(key))),
		trigger: run.data['$trigger'],
		last: run.data['$last'],
		accountability: run.data['$accountability'],
		outcome,
		reason,
	};
}

/**
 * Classifies a run into an outcome and reason. The stored record holds each step's identity and status, but not the
 * flow's trigger or the step's type, so those come from the current rows.
 */
async function classifyRun(database: Knex, run: FinishedRun, steps: StoredStep[]): Promise<RunClassification> {
	const unrecognized = (reason: string) =>
		new Error(`Run record ${run.revision} of flow ${run.flow} cannot be classified: ${reason}`);

	const last = steps.at(-1);
	if (!last) return { outcome: 'completed', reason: null };
	const { operation, status, options } = last;

	if (typeof operation !== 'string') throw unrecognized('its last step has no identity');

	const flow = await database('directus_flows').where('id', run.flow).first('trigger', 'options');
	if (!flow) throw unrecognized('its flow is no longer stored');
	const flowOptions = decodeJson(flow.options, () => unrecognized('its flow options are not JSON'));
	if (flowOptions !== null && !isRecord(flowOptions)) throw unrecognized('its flow options are not an object');
	const blocking = flow.trigger === 'event' && flowOptions?.['type'] === 'filter';

	const step = await database('directus_operations').where('id', operation).first('flow', 'type');
	if (!step) throw unrecognized('its last step is no longer stored');
	if (step.flow !== run.flow) throw unrecognized('its last step belongs to another flow');

	// The last step's own key can be a sensitive name whose value is masked whole. `$last` holds the same result
	// with its outer shape intact, which is all the classification reads.
	const result = run.data['$last'];
	let reason: RunReason | null = null;

	if (status === 'unknown') reason = 'STEP_UNAVAILABLE';

	if (status === 'reject') {
		if (options === null && isRecord(result) && result['message'] === AMBIGUOUS_STEP_MESSAGE)
			reason = 'STEP_UNAVAILABLE';
		else if (step.type !== 'condition') reason = 'STEP_FAILED';
		else if (Array.isArray(result)) reason = 'CONDITION_FALSE';
		else if (isRecord(result) && typeof result['message'] === 'string') reason = 'CONDITION_ERROR';
		else throw unrecognized('its Condition failed with data of an unknown shape');
	}

	if (reason === null) return { outcome: 'completed', reason };
	if (blocking) return { outcome: 'refused', reason };
	if (reason === 'CONDITION_FALSE') return { outcome: 'completed', reason };
	return { outcome: 'failed', reason };
}

function runActivity(database: Knex, flowId: string, after: number): Knex.QueryBuilder {
	return database('directus_activity')
		.where('directus_activity.action', 'run')
		.andWhere('directus_activity.collection', 'directus_flows')
		.andWhere('directus_activity.item', flowId)
		.andWhere('directus_activity.id', '>', after);
}

/** Converts a stored run record, rejecting any shape the current runner does not write. */
function toFinishedRun(flowId: string, row: RunRow): FinishedRun {
	const reject = (reason: string) =>
		new Error(`Run record ${row.revision} of flow ${flowId} has an unrecognized shape: ${reason}`);

	const parsed = decodeJson(row.data, () => reject('its data is not JSON'));

	if (!isRecord(parsed)) throw reject('its data is not an object');
	if (!Array.isArray(parsed['steps'])) throw reject('it has no steps list');
	if (!isRecord(parsed['data'])) throw reject('it has no data object');

	return {
		flow: flowId,
		activity: Number(row.activity),
		revision: Number(row.revision),
		steps: parsed['steps'],
		data: parsed['data'],
	};
}

/** Decodes a JSON column, which SQLite and MySQL return as text and PostgreSQL returns already parsed. */
function decodeJson(value: unknown, invalid: () => Error): unknown {
	if (typeof value !== 'string') return value;

	try {
		return JSON.parse(value);
	} catch {
		throw invalid();
	}
}

function isStoredStatus(value: unknown): value is StoredStatus {
	return value === 'resolve' || value === 'reject' || value === 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
