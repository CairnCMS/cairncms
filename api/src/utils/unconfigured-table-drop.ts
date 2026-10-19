import type { Collection } from '../types/index.js';
import { safeLogFragment } from './safe-log-fragment.js';

/** Inspects the captured deleted definition, not the diff deltas: a table (non-null `schema`) with no metadata row (null `meta`). */
export function isUnconfiguredTableDrop(definition: Collection | undefined): boolean {
	return definition?.schema != null && definition?.meta == null;
}

export function unconfiguredTableDropMessage(collection: string): string {
	return `Deleting table "${safeLogFragment(
		collection
	)}" will remove its data. It has no CairnCMS collection record and may belong to another application.`;
}
