import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolves a declared entry to its real path only when, after following symlinks,
 * it is a regular file strictly inside the real package root. Lexical containment
 * alone would let a symlink inside the package escape to a file outside it.
 */
export async function realEntryInsideRoot(root: string, relativeEntry: string): Promise<string | null> {
	let realRoot: string;
	let realEntry: string;

	try {
		realRoot = await realpath(root);
		realEntry = await realpath(path.resolve(realRoot, relativeEntry));
	} catch {
		return null;
	}

	const relative = path.relative(realRoot, realEntry);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;

	try {
		if (!(await stat(realEntry)).isFile()) return null;
	} catch {
		return null;
	}

	return realEntry;
}
