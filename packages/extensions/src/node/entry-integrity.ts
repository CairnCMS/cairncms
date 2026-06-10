import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type EntryPathClass = { kind: 'inside'; real: string } | { kind: 'escapes-root' } | { kind: 'unresolved' };

/**
 * Classifies a declared entry or local path against the real package root:
 * `inside` (with the real path) when, after following symlinks, it is a regular
 * file strictly inside the root, `escapes-root` when it resolves to a real
 * location outside the root, and `unresolved` when it does not resolve to a
 * regular file at all. Lexical containment alone would let a symlink inside the
 * package escape to a file outside it.
 */
export async function classifyEntryPath(root: string, relativeEntry: string): Promise<EntryPathClass> {
	let realRoot: string;
	let realEntry: string;

	try {
		realRoot = await realpath(root);
		realEntry = await realpath(path.resolve(realRoot, relativeEntry));
	} catch {
		return { kind: 'unresolved' };
	}

	const relative = path.relative(realRoot, realEntry);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return { kind: 'escapes-root' };
	if (relative === '') return { kind: 'unresolved' };

	try {
		if (!(await stat(realEntry)).isFile()) return { kind: 'unresolved' };
	} catch {
		return { kind: 'unresolved' };
	}

	return { kind: 'inside', real: realEntry };
}

/**
 * Resolves a declared entry to its real path only when, after following symlinks,
 * it is a regular file strictly inside the real package root.
 */
export async function realEntryInsideRoot(root: string, relativeEntry: string): Promise<string | null> {
	const classified = await classifyEntryPath(root, relativeEntry);
	return classified.kind === 'inside' ? classified.real : null;
}
