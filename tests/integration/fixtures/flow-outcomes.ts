import type { Knex } from 'knex';

export type FinishedRun = {
	activity: number;
	revision: number;
	steps: unknown[];
	data: Record<string, unknown>;
};

type RunRow = { activity: number | string; revision: number | string; data: unknown };

/** Reads the finished runs of a flow whose activity rows are above `after`, oldest first. */
export async function readFinishedRuns(
	database: Knex,
	flowId: string,
	{ after = 0 }: { after?: number } = {}
): Promise<FinishedRun[]> {
	const rows: RunRow[] = await database('directus_activity')
		.join('directus_revisions', 'directus_revisions.activity', 'directus_activity.id')
		.where('directus_activity.action', 'run')
		.andWhere('directus_activity.collection', 'directus_flows')
		.andWhere('directus_activity.item', flowId)
		.andWhere('directus_activity.id', '>', after)
		.orderBy('directus_activity.id')
		.select('directus_activity.id as activity', 'directus_revisions.id as revision', 'directus_revisions.data');

	return rows.map((row) => toFinishedRun(flowId, row));
}

/** Reads the highest activity id, which marks where a case's own run records begin. */
export async function readActivityBaseline(database: Knex): Promise<number> {
	const row = await database('directus_activity').max('id as id').first();
	return Number(row?.id ?? 0);
}

/** Converts a stored run record, rejecting any shape the current runner does not write. */
function toFinishedRun(flowId: string, row: RunRow): FinishedRun {
	const reject = (reason: string) =>
		new Error(`Run record ${row.revision} of flow ${flowId} has an unrecognized shape: ${reason}`);

	let parsed: unknown = row.data;

	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw reject('its data is not JSON');
		}
	}

	if (!isRecord(parsed)) throw reject('its data is not an object');
	if (!Array.isArray(parsed['steps'])) throw reject('it has no steps list');
	if (!isRecord(parsed['data'])) throw reject('it has no data object');

	return {
		activity: Number(row.activity),
		revision: Number(row.revision),
		steps: parsed['steps'],
		data: parsed['data'],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
