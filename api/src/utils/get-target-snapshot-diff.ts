import type { Knex } from 'knex';
import type { PortableSnapshot, Snapshot, SnapshotDiff } from '../types/index.js';
import type { KeyFormState } from './folder-references.js';
import { alignToDesiredReferences, toKeyFormSnapshot, validateFolderReferences } from './folder-references.js';
import { getSnapshotDiff } from './get-snapshot-diff.js';
import { reconcileDesiredSchema } from './reconcile-desired-schema.js';
import { validateSnapshotHeader } from './validate-snapshot.js';

export async function getTargetSnapshotDiff(
	desired: Snapshot | PortableSnapshot,
	options: { current: Snapshot; currentKeyForm?: KeyFormState; database: Knex }
): Promise<SnapshotDiff> {
	validateSnapshotHeader(desired);

	if (desired.version === 1) return getSnapshotDiff(options.current, reconcileDesiredSchema(options.current, desired));

	const keyForm = options.currentKeyForm ?? (await toKeyFormSnapshot(options.current, { database: options.database }));
	const reconciled = reconcileDesiredSchema(keyForm.snapshot, desired);
	validateFolderReferences(reconciled.fields ?? [], keyForm.folderIdByKey);

	const comparison: Snapshot = {
		...keyForm.snapshot,
		fields: alignToDesiredReferences(keyForm.snapshot.fields, options.current.fields, reconciled.fields ?? []),
	};

	return getSnapshotDiff(comparison, reconciled);
}
