import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePackageExtensions } from './get-extensions.js';

const roots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), 'cairn-discovery-'));
	roots.push(root);
	writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host-project' }));
	return root;
}

function writePackage(root: string, name: string, manifest: Record<string, unknown>): void {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

const validManifest = {
	name: 'cairncms-extension-good',
	version: '1.0.0',
	'cairncms:extension': { type: 'endpoint', path: 'dist/index.js', source: 'src/index.js', host: '^1.0.0' },
};

const badManifest = {
	name: 'cairncms-extension-bad',
	version: '1.0.0',
	'cairncms:extension': { type: 'not-a-real-type' },
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolvePackageExtensions discovery resilience', () => {
	it('still throws on a bad manifest when no failure collector is provided', async () => {
		const root = makeRoot();
		writePackage(root, 'cairncms-extension-bad', badManifest);

		await expect(resolvePackageExtensions(root)).rejects.toThrow();
	});

	it('collects a bad manifest and keeps loading the rest of the batch', async () => {
		const root = makeRoot();
		writePackage(root, 'cairncms-extension-good', validManifest);
		writePackage(root, 'cairncms-extension-bad', badManifest);

		const failures: { name: string; local: boolean }[] = [];
		const extensions = await resolvePackageExtensions(root, undefined, (failure) => failures.push(failure));

		expect(extensions.map((extension) => extension.name)).toContain('cairncms-extension-good');
		expect(failures.map((failure) => failure.name)).toContain('cairncms-extension-bad');
		expect(failures[0]?.local).toBe(true);
	});

	it('routes an unresolvable package dependency through the collector', async () => {
		const root = makeRoot();

		const failures: { name: string; local: boolean }[] = [];

		const extensions = await resolvePackageExtensions(root, ['cairncms-extension-missing'], (failure) =>
			failures.push(failure)
		);

		expect(extensions).toHaveLength(0);
		expect(failures.map((failure) => failure.name)).toContain('cairncms-extension-missing');
		expect(failures[0]?.local).toBe(false);
	});
});
