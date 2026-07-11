import { NESTED_EXTENSION_TYPES } from '@cairncms/constants';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureExtensionDirs } from './ensure-extension-dirs.js';
import { getLocalExtensions, resolvePackageExtensions } from './get-extensions.js';

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

	it('fails a manifest with an invalid settings presentation at discovery and carries a valid one through', async () => {
		const root = makeRoot();

		const settingsFor = (scope: string) => ({
			preview_url: {
				type: 'string',
				scope,
				appReadable: true,
				presentation: { interface: 'system-display-template' },
			},
		});

		writePackage(root, 'cairncms-extension-template-ok', {
			name: 'cairncms-extension-template-ok',
			version: '1.0.0',
			'cairncms:extension': {
				type: 'endpoint',
				path: 'dist/index.js',
				source: 'src/index.js',
				host: '^1.0.0',
				settings: settingsFor('collection'),
			},
		});

		writePackage(root, 'cairncms-extension-template-bad', {
			name: 'cairncms-extension-template-bad',
			version: '1.0.0',
			'cairncms:extension': {
				type: 'endpoint',
				path: 'dist/index.js',
				source: 'src/index.js',
				host: '^1.0.0',
				settings: settingsFor('global'),
			},
		});

		const failures: { name: string; local: boolean }[] = [];
		const extensions = await resolvePackageExtensions(root, undefined, (failure) => failures.push(failure));

		expect(failures.map((failure) => failure.name)).toContain('cairncms-extension-template-bad');

		const carried = extensions.find((extension) => extension.name === 'cairncms-extension-template-ok');
		expect(carried?.settings?.['preview_url']?.presentation?.interface).toBe('system-display-template');
	});
});

const confinedEndpointManifest = {
	name: 'cairncms-extension-confined-endpoint',
	version: '1.0.0',
	'cairncms:extension': {
		type: 'endpoint',
		path: 'dist/index.js',
		source: 'src/index.js',
		host: '^1.0.0',
		runtime: 'confined-server',
	},
};

const confinedOperationManifest = {
	name: 'cairncms-extension-confined-operation',
	version: '1.0.0',
	'cairncms:extension': {
		type: 'operation',
		path: { app: 'dist/app.js', api: 'dist/api.js' },
		source: { app: 'src/app.js', api: 'src/api.js' },
		host: '^1.0.0',
		runtime: 'confined-server',
	},
};

const confinedBundleManifest = {
	name: 'cairncms-extension-confined-bundle',
	version: '1.0.0',
	'cairncms:extension': {
		type: 'bundle',
		path: { app: 'dist/app.js', api: 'dist/api.js' },
		host: '^1.0.0',
		runtime: 'confined-server',
		entries: [{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js' }],
	},
};

describe('runtime metadata threading', () => {
	it('carries runtime confined-server from an endpoint manifest', async () => {
		const root = makeRoot();
		writePackage(root, 'cairncms-extension-confined-endpoint', confinedEndpointManifest);

		const [extension] = await resolvePackageExtensions(root);

		expect(extension?.runtime).toBe('confined-server');
	});

	it('carries runtime confined-server from a hybrid manifest', async () => {
		const root = makeRoot();
		writePackage(root, 'cairncms-extension-confined-operation', confinedOperationManifest);

		const [extension] = await resolvePackageExtensions(root);

		expect(extension?.runtime).toBe('confined-server');
	});

	it('carries runtime confined-server from a bundle manifest', async () => {
		const root = makeRoot();
		writePackage(root, 'cairncms-extension-confined-bundle', confinedBundleManifest);

		const [extension] = await resolvePackageExtensions(root);

		expect(extension?.runtime).toBe('confined-server');
	});

	it('leaves a plain manifest without a runtime', async () => {
		const root = makeRoot();
		writePackage(root, 'cairncms-extension-good', validManifest);

		const [extension] = await resolvePackageExtensions(root);

		expect(extension?.runtime).toBeUndefined();
	});

	it('gives folder drop-ins no runtime', async () => {
		const root = makeRoot();
		await ensureExtensionDirs(root, NESTED_EXTENSION_TYPES);
		const dropIn = path.join(root, 'endpoints', 'my-endpoint');
		mkdirSync(dropIn, { recursive: true });
		writeFileSync(path.join(dropIn, 'index.js'), 'export default {};');

		const extensions = await getLocalExtensions(root);
		const endpoint = extensions.find((extension) => extension.name === 'my-endpoint');

		expect(endpoint?.type).toBe('endpoint');
		expect(endpoint?.runtime).toBeUndefined();
	});
});
