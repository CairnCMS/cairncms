import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getExtensionRealPaths, isUnderExtensions } from './vite-extension-utils.js';

describe('isUnderExtensions', () => {
	it('accepts a path inside the extensions root', () => {
		expect(isUnderExtensions('/api/extensions', '/api/extensions/interfaces/foo/index.js')).toBe(true);
	});

	it('rejects a sibling directory that shares a prefix', () => {
		expect(isUnderExtensions('/api/extensions', '/api/extensions-other/foo')).toBe(false);
	});

	it('rejects the root itself and unrelated paths', () => {
		expect(isUnderExtensions('/api/extensions', '/api/extensions')).toBe(false);
		expect(isUnderExtensions('/api/extensions', '/elsewhere/foo')).toBe(false);
	});
});

describe('getExtensionRealPaths', () => {
	let root: string;
	let external: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), 'cairn-ext-root-'));
		external = mkdtempSync(path.join(tmpdir(), 'cairn-ext-external-'));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(external, { recursive: true, force: true });
	});

	it('includes a folder-layout extension directory', () => {
		mkdirSync(path.join(root, 'interfaces', 'foo'), { recursive: true });

		const paths = getExtensionRealPaths(root);

		expect(paths.some((p) => p.endsWith(path.join('interfaces', 'foo')))).toBe(true);
	});

	it('resolves a symlinked package extension instead of skipping it', () => {
		const realPackage = path.join(external, 'cairncms-extension-foo');
		mkdirSync(path.join(realPackage, 'dist'), { recursive: true });
		writeFileSync(path.join(realPackage, 'package.json'), '{}');
		symlinkSync(realPackage, path.join(root, 'cairncms-extension-foo'));

		const paths = getExtensionRealPaths(root);

		expect(paths.some((p) => p.endsWith('cairncms-extension-foo'))).toBe(true);
		expect(paths.some((p) => p.endsWith(path.join('cairncms-extension-foo', 'dist')))).toBe(true);
	});

	it('returns an empty list when the extensions path is absent', () => {
		expect(getExtensionRealPaths(path.join(root, 'does-not-exist'))).toEqual([]);
	});
});
