import type { DiffDeleted, DiffNew } from 'deep-diff';
import type { Collection, SnapshotDiff } from '../types/index.js';
import { DiffKind } from '../types/index.js';
import { isEntityDelete } from './is-entity-delete.js';
import { isNestedMetaUpdate } from './is-nested-meta-update.js';

/**
 * Lists every collection the diff deletes, each once and after the deleted collections grouped under it, which is the
 * order both the schema apply writer and its preflight follow. Only a whole-collection delete counts, not the removal
 * of one attribute such as `schema` or `meta`. A collection whose group survives, or that has no metadata row, starts a
 * walk like a top-level one.
 */
export function collectionDeleteOrder(snapshotDiff: SnapshotDiff): string[] {
	const groupOf = new Map<string, string | null>();

	for (const { collection, diff } of snapshotDiff.collections) {
		if (!isEntityDelete(diff[0])) continue;
		groupOf.set(collection, (diff[0] as DiffDeleted<Collection>).lhs?.meta?.group ?? null);
	}

	return groupOrder(groupOf, 'children-first');
}

/**
 * Lists every collection the diff creates, each once and after the created collection it is grouped under, because a
 * group's metadata row must exist before a collection can name it. A collection grouped under none, or under one the
 * diff does not create, starts a walk. A create that adds one attribute to an existing collection is listed as well,
 * and the preflight refuses it because the collection already exists.
 */
export function collectionCreateOrder(snapshotDiff: SnapshotDiff): string[] {
	const groupOf = new Map<string, string | null>();

	for (const { collection, diff } of snapshotDiff.collections) {
		if (diff[0]?.kind !== DiffKind.NEW || isNestedMetaUpdate(diff[0])) continue;
		groupOf.set(collection, (diff[0] as DiffNew<Collection>).rhs?.meta?.group ?? null);
	}

	return groupOrder(groupOf, 'parents-first');
}

/**
 * Walks the collections along their groups from each one whose group is outside the map, then from any still
 * unvisited, which can only belong to a group cycle. Every collection is listed once, and a cycle is broken at the
 * first member reached.
 */
function groupOrder(
	groupOf: ReadonlyMap<string, string | null>,
	direction: 'children-first' | 'parents-first'
): string[] {
	const order: string[] = [];
	const visited = new Set<string>();

	const visit = (collection: string): void => {
		if (visited.has(collection)) return;
		visited.add(collection);

		if (direction === 'parents-first') order.push(collection);

		for (const [member, group] of groupOf) {
			if (group === collection) visit(member);
		}

		if (direction === 'children-first') order.push(collection);
	};

	for (const [collection, group] of groupOf) {
		if (group === null || !groupOf.has(group)) visit(collection);
	}

	for (const collection of groupOf.keys()) visit(collection);

	return order;
}
