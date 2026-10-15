import type { DiffDeleted } from 'deep-diff';
import type { Collection, SnapshotDiff } from '../types/index.js';
import { isEntityDelete } from './is-entity-delete.js';

/**
 * Lists every collection the diff deletes, each once and after the deleted collections grouped under it, which is the
 * order both the schema apply writer and its preflight follow. Only a whole-collection delete counts, not the removal
 * of one attribute such as `schema` or `meta`. A collection whose
 * group survives, or that has no metadata row, starts a walk like a top-level one. Collections whose groups form a
 * cycle are still listed, with the cycle broken at the first member reached.
 */
export function collectionDeleteOrder(snapshotDiff: SnapshotDiff): string[] {
	const groupOf = new Map<string, string | null>();

	for (const { collection, diff } of snapshotDiff.collections) {
		if (!isEntityDelete(diff[0])) continue;
		groupOf.set(collection, (diff[0] as DiffDeleted<Collection>).lhs?.meta?.group ?? null);
	}

	const order: string[] = [];
	const visited = new Set<string>();

	const visit = (collection: string): void => {
		if (visited.has(collection)) return;
		visited.add(collection);

		for (const [member, group] of groupOf) {
			if (group === collection) visit(member);
		}

		order.push(collection);
	};

	for (const [collection, group] of groupOf) {
		if (group === null || !groupOf.has(group)) visit(collection);
	}

	for (const collection of groupOf.keys()) visit(collection);

	return order;
}
