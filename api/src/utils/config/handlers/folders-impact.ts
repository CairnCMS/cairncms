import type { Knex } from 'knex';
import type { FolderDeletionImpactEntry } from '../../../types/config.js';
import { resolveFolderReference } from '../folder-id-lookup.js';

type FolderDeletionPlan = {
	delete: string[];
	update: { key: string; changes: { parent?: unknown } }[];
};

type Blocker = FolderDeletionImpactEntry['blockedBy'];

const BLOCKER_ORDER: Blocker[] = ['files', 'folders', 'storage_default_folder', 'options.folder'];

function parseOptions(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === 'object') return value as Record<string, unknown>;

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	return undefined;
}

function orderBlockers(observed: Set<Blocker>): FolderDeletionImpactEntry[] {
	return BLOCKER_ORDER.filter((blocker) => observed.has(blocker)).map((blockedBy) => ({ blockedBy }));
}

/**
 * Observes the categories that would block each planned folder deletion, accounting for children this
 * same plan deletes or reparents away. It is an advisory point-in-time preview. The authoritative check
 * still runs inside the apply transaction immediately before each delete.
 */
export async function readFolderDeletionImpact(
	plan: FolderDeletionPlan,
	database: Knex
): Promise<Map<string, FolderDeletionImpactEntry[]>> {
	const result = new Map<string, FolderDeletionImpactEntry[]>();
	if (plan.delete.length === 0) return result;

	const rows = await database('directus_folders').select('id', 'key', 'parent');
	const folderIdByKey = new Map<string, string>(rows.map((row) => [row['key'], row['id']]));
	const keyById = new Map<string, string>(rows.map((row) => [row['id'], row['key']]));

	const deletedKeys = new Set(plan.delete);
	const reparentedKeys = new Set<string>();

	for (const update of plan.update) {
		if (update.changes.parent !== undefined) reparentedKeys.add(update.key);
	}

	const childrenByParentKey = new Map<string, string[]>();

	for (const row of rows) {
		const parentKey =
			row['parent'] === null ? null : (await resolveFolderReference(database, keyById, row['parent'])) ?? null;

		if (parentKey === null) continue;

		const siblings = childrenByParentKey.get(parentKey) ?? [];
		siblings.push(row['key']);
		childrenByParentKey.set(parentKey, siblings);
	}

	const deletionIdToKey = new Map<string, string>();

	for (const key of plan.delete) {
		const id = folderIdByKey.get(key);
		if (id !== undefined) deletionIdToKey.set(id, key);
	}

	const optionsFolderBlocked = new Set<string>();
	const fields = await database.select('options').from('directus_fields').whereNotNull('options');

	for (const field of fields) {
		const folder = parseOptions(field['options'])?.['folder'];
		const blockedKey = await resolveFolderReference(database, deletionIdToKey, folder);
		if (blockedKey !== undefined) optionsFolderBlocked.add(blockedKey);
	}

	for (const key of plan.delete) {
		const id = folderIdByKey.get(key);

		if (id === undefined) {
			result.set(key, []);
			continue;
		}

		const observed = new Set<Blocker>();

		const file = await database('directus_files').where('folder', id).first('id');
		if (file) observed.add('files');

		const remainingChild = (childrenByParentKey.get(key) ?? []).some(
			(childKey) => !deletedKeys.has(childKey) && !reparentedKeys.has(childKey)
		);

		if (remainingChild) observed.add('folders');

		const setting = await database('directus_settings').where('storage_default_folder', id).first('id');
		if (setting) observed.add('storage_default_folder');

		if (optionsFolderBlocked.has(key)) observed.add('options.folder');

		result.set(key, orderBlockers(observed));
	}

	return result;
}

export function normalizeFolderImpact(entries: FolderDeletionImpactEntry[] | undefined): FolderDeletionImpactEntry[] {
	if (!entries) return [];

	const observed = new Set<Blocker>(entries.map((entry) => entry.blockedBy));
	return orderBlockers(observed);
}
