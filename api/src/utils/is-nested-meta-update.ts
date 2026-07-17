import type { Diff } from 'deep-diff';
import { DiffKind } from '../types/index.js';

/** deep-diff omits `path` for whole-entity changes and includes it for nested changes. */
export function isNestedMetaUpdate(diff: Diff<unknown> | undefined): boolean {
	if (!diff) return false;
	if (diff.kind !== DiffKind.NEW && diff.kind !== DiffKind.DELETE) return false;
	if (!diff.path || diff.path.length < 2 || diff.path[0] !== 'meta') return false;
	return true;
}
