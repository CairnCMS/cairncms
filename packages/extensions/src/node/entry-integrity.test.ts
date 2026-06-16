import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyEntryPath, realEntryInsideRoot } from './entry-integrity.js';

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

// A fresh real base temp dir plus a package root inside it, so a test can place
// files both inside the root and as siblings outside it.
async function makeBase(): Promise<{ base: string; root: string }> {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cairn-entry-')));
	created.push(base);
	const root = path.join(base, 'pkg');
	await mkdir(root);
	return { base, root };
}

describe('realEntryInsideRoot', () => {
	it('resolves a regular file inside the root', async () => {
		const { root } = await makeBase();
		await writeFile(path.join(root, 'index.js'), 'export default {};');
		expect(await realEntryInsideRoot(root, 'index.js')).toBe(path.join(root, 'index.js'));
	});

	it('returns null for a missing entry', async () => {
		const { root } = await makeBase();
		expect(await realEntryInsideRoot(root, 'missing.js')).toBeNull();
	});

	it('returns null when the entry resolves to the root directory itself', async () => {
		const { root } = await makeBase();
		expect(await realEntryInsideRoot(root, '.')).toBeNull();
	});

	it('returns null for a traversing entry that escapes the root', async () => {
		const { base, root } = await makeBase();
		await writeFile(path.join(base, 'outside.js'), 'export default {};');
		expect(await realEntryInsideRoot(root, '../outside.js')).toBeNull();
	});

	it('returns null for a symlink inside the root that escapes it', async () => {
		const { base, root } = await makeBase();
		const target = path.join(base, 'secret.js');
		await writeFile(target, 'export default {};');
		await symlink(target, path.join(root, 'link.js'));
		expect(await realEntryInsideRoot(root, 'link.js')).toBeNull();
	});

	it('resolves a symlink inside the root that points back inside the root', async () => {
		const { root } = await makeBase();
		const realFile = path.join(root, 'real.js');
		await writeFile(realFile, 'export default {};');
		await symlink(realFile, path.join(root, 'link.js'));
		expect(await realEntryInsideRoot(root, 'link.js')).toBe(realFile);
	});
});

describe('classifyEntryPath', () => {
	it('classifies a regular file inside the root as inside with its real path', async () => {
		const { root } = await makeBase();
		await writeFile(path.join(root, 'index.js'), 'export default {};');
		expect(await classifyEntryPath(root, 'index.js')).toEqual({ kind: 'inside', real: path.join(root, 'index.js') });
	});

	it('classifies a missing entry as unresolved', async () => {
		const { root } = await makeBase();
		expect(await classifyEntryPath(root, 'missing.js')).toEqual({ kind: 'unresolved' });
	});

	it('classifies the root directory itself as unresolved', async () => {
		const { root } = await makeBase();
		expect(await classifyEntryPath(root, '.')).toEqual({ kind: 'unresolved' });
	});

	it('classifies a traversing entry that resolves to a real outside file as escaping', async () => {
		const { base, root } = await makeBase();
		await writeFile(path.join(base, 'outside.js'), 'export default {};');
		expect(await classifyEntryPath(root, '../outside.js')).toEqual({ kind: 'escapes-root' });
	});

	it('classifies a symlink that escapes the root as escaping', async () => {
		const { base, root } = await makeBase();
		const target = path.join(base, 'secret.js');
		await writeFile(target, 'export default {};');
		await symlink(target, path.join(root, 'link.js'));
		expect(await classifyEntryPath(root, 'link.js')).toEqual({ kind: 'escapes-root' });
	});

	it('classifies a traversal to a missing outside file as unresolved, not escaping', async () => {
		const { root } = await makeBase();
		expect(await classifyEntryPath(root, '../missing.js')).toEqual({ kind: 'unresolved' });
	});
});
