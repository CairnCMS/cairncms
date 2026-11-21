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

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type RunReason = (typeof RUN_REASONS)[number];
export type RunClassification = { outcome: RunOutcome; reason: RunReason | null };

export type FinishedRun = {
	flow: string;
	activity: number;
	revision: number;
	steps: unknown[];
	data: Record<string, unknown>;
};

type RunRow = { activity: number | string; revision: number | string; data: unknown };

const AMBIGUOUS_STEP_MESSAGE = 'the operation could not be resolved';

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

/**
 * Classifies a fixture run into an outcome and reason from its stored record. The record holds each step's identity
 * and status, but not the flow's trigger or the step's type, so those come from the current rows. Those rows describe
 * the run only until the case reinstalls or cleans up the flow, so classify before either.
 */
export async function readRunOutcome(database: Knex, run: FinishedRun): Promise<RunClassification> {
	const unrecognized = (reason: string) =>
		new Error(`Run record ${run.revision} of flow ${run.flow} cannot be classified: ${reason}`);

	const last = run.steps.at(-1);
	if (!isRecord(last)) throw unrecognized('it has no steps');
	const { operation, status, options } = last;

	if (status !== 'resolve' && status !== 'reject' && status !== 'unknown')
		throw unrecognized(`its last step has status ${JSON.stringify(status)}`);

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
