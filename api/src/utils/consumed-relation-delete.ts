import type { Diff } from 'deep-diff';
import { schemaDiffOperation } from './schema-diff-operation.js';
import { schemaEntityKey } from './schema-entity-key.js';

export function isConsumedRelationDelete(
	entry: { collection: string; field: string; diff: readonly Diff<unknown>[] },
	consumed: ReadonlySet<string>
): boolean {
	return schemaDiffOperation(entry.diff) === 'delete' && consumed.has(schemaEntityKey(entry.collection, entry.field));
}
