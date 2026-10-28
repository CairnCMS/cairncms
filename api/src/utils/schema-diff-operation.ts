import type { Diff } from 'deep-diff';
import type { SchemaOperation } from '../types/index.js';
import { DiffKind } from '../types/index.js';
import { isEntityDelete } from './is-entity-delete.js';

/**
 * deep-diff reports a change to the whole entity without a path, so only a diff that starts with such an entry
 * creates or deletes the field or relation. Any other diff changes an entity that exists on both sides.
 */
export function schemaDiffOperation(diff: readonly Diff<unknown>[]): SchemaOperation {
	const first = diff[0];

	if (first?.kind === DiffKind.NEW && (first.path?.length ?? 0) === 0) return 'create';
	if (isEntityDelete(first)) return 'delete';

	return 'update';
}
