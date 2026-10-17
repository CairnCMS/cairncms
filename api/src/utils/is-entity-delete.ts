import type { Diff } from 'deep-diff';
import { DiffKind } from '../types/index.js';

/** deep-diff omits `path` for a change to the whole entity, so only a delete without one removes the entity. */
export function isEntityDelete(diff: Diff<unknown> | undefined): boolean {
	return diff?.kind === DiffKind.DELETE && (diff.path?.length ?? 0) === 0;
}
