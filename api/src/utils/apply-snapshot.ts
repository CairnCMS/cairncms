import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { getCache } from '../cache.js';
import getDatabase from '../database/index.js';
import type { PortableSnapshot, Snapshot, SnapshotDiff } from '../types/index.js';
import { applyDiff } from './apply-diff.js';
import { getSchema } from './get-schema.js';
import { getSnapshot } from './get-snapshot.js';
import { getTargetSnapshotDiff } from './get-target-snapshot-diff.js';

export async function applySnapshot(
	snapshot: Snapshot | PortableSnapshot,
	options?: { database?: Knex; schema?: SchemaOverview; current?: Snapshot; diff?: SnapshotDiff }
): Promise<void> {
	const database = options?.database ?? getDatabase();
	const schema = options?.schema ?? (await getSchema({ database, bypassCache: true }));
	const { systemCache } = getCache();

	const current = options?.current ?? (await getSnapshot({ database, schema }));
	const snapshotDiff = options?.diff ?? (await getTargetSnapshotDiff(snapshot, { current, database }));

	await applyDiff(current, snapshotDiff, { database, schema });

	await systemCache?.clear();
}
