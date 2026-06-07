import type { Extension } from '@cairncms/types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
	envState: { EXTENSIONS_PATH: './extensions', SERVE_APP: false, EXTENSIONS_AUTO_RELOAD: false } as Record<
		string,
		unknown
	>,
}));

vi.mock('./env.js', () => ({ default: envState, getEnv: () => envState, refreshEnv: () => undefined }));

// The internal-operations loop reads its directory with a template-literal dynamic
// import that the test bundler cannot resolve. Skipping that read lets the test
// exercise the extension-operations lane, which is the path under test.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, readdir: async () => [] };
});

import { ExtensionManager } from './extensions.js';
import { filterServerExtensions } from './utils/filter-server-extensions.js';

let root: string;

function writeThrowingEntry(dir: string, file: string, marker: string): void {
	const full = path.join(root, dir);
	mkdirSync(full, { recursive: true });
	writeFileSync(path.join(full, file), `throw new Error(${JSON.stringify(marker)});\n`);
}

function endpointExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'endpoint',
		entrypoint: 'index.js',
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

function hookExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'hook',
		entrypoint: 'index.js',
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

function operationExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'operation',
		entrypoint: { app: 'app.js', api: 'api.js' },
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

function bundleExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'bundle',
		entrypoint: { app: 'app.js', api: 'api.js' },
		entries: [{ type: 'endpoint', name: `${name}-endpoint` }],
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

function manager(extensions: Extension[]): ExtensionManager {
	const instance = new ExtensionManager();
	(instance as any).extensions = extensions;
	(instance as any).serverExtensions = filterServerExtensions(extensions);
	(instance as any).diagnostics = [];
	return instance;
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), 'cairn-confined-'));
	envState['EXTENSIONS_PATH'] = root;
	writeThrowingEntry('confined-endpoint', 'index.js', 'CONFINED_ENDPOINT_IMPORTED');
	writeThrowingEntry('control-endpoint', 'index.js', 'CONTROL_ENDPOINT_IMPORTED');
	writeThrowingEntry('confined-hook', 'index.js', 'CONFINED_HOOK_IMPORTED');
	writeThrowingEntry('control-hook', 'index.js', 'CONTROL_HOOK_IMPORTED');
	writeThrowingEntry('confined-operation', 'api.js', 'CONFINED_OPERATION_IMPORTED');
	writeThrowingEntry('control-operation', 'api.js', 'CONTROL_OPERATION_IMPORTED');
	writeThrowingEntry('confined-bundle', 'api.js', 'CONFINED_BUNDLE_IMPORTED');
	writeThrowingEntry('control-bundle', 'api.js', 'CONTROL_BUNDLE_IMPORTED');
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('a confined server extension never reaches the full-authority import path', () => {
	it('registerEndpoints imports a plain endpoint but never a confined one', async () => {
		const instance = manager([
			endpointExtension('confined-endpoint', 'confined-endpoint', true),
			endpointExtension('control-endpoint', 'control-endpoint', false),
		]);

		await (instance as any).registerEndpoints();

		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.find((entry: any) => entry.name === 'control-endpoint')?.status).toBe('failed');
		expect(diagnostics.map((entry: any) => entry.name)).not.toContain('confined-endpoint');
	});

	it('registerHooks imports a plain hook but never a confined one', async () => {
		const instance = manager([
			hookExtension('confined-hook', 'confined-hook', true),
			hookExtension('control-hook', 'control-hook', false),
		]);

		await (instance as any).registerHooks();

		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.find((entry: any) => entry.name === 'control-hook')?.status).toBe('failed');
		expect(diagnostics.map((entry: any) => entry.name)).not.toContain('confined-hook');
	});

	it('registerOperations imports a plain operation but never a confined one', async () => {
		const instance = manager([
			operationExtension('confined-operation', 'confined-operation', true),
			operationExtension('control-operation', 'control-operation', false),
		]);

		await (instance as any).registerOperations();

		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.find((entry: any) => entry.name === 'control-operation')?.status).toBe('failed');
		expect(diagnostics.map((entry: any) => entry.name)).not.toContain('confined-operation');
	});

	it('registerBundles imports a plain bundle but never a confined one', async () => {
		const instance = manager([
			bundleExtension('confined-bundle', 'confined-bundle', true),
			bundleExtension('control-bundle', 'control-bundle', false),
		]);

		await (instance as any).registerBundles();

		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.find((entry: any) => entry.name === 'control-bundle')?.status).toBe('failed');
		expect(diagnostics.map((entry: any) => entry.name)).not.toContain('confined-bundle');
	});

	it('load computes the confined lane itself before registration', async () => {
		const instance = new ExtensionManager();

		const extensions = [
			endpointExtension('confined-endpoint', 'confined-endpoint', true),
			endpointExtension('control-endpoint', 'control-endpoint', false),
		];

		(instance as any).getExtensions = async () => extensions;

		await (instance as any).load();

		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.find((entry: any) => entry.name === 'control-endpoint')?.status).toBe('failed');
		expect(diagnostics.map((entry: any) => entry.name)).not.toContain('confined-endpoint');
	});
});
