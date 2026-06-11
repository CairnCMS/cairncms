import type { Extension } from '@cairncms/types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { envState, confinedRuntime } = vi.hoisted(() => ({
	envState: { EXTENSIONS_PATH: './extensions', SERVE_APP: false, EXTENSIONS_AUTO_RELOAD: false } as Record<
		string,
		unknown
	>,
	// The manager resolves the confined runtime at load. The real resolver detects
	// host hardening by spawning probes, so the whole suite drives it through this
	// controllable stub: a baseline success by default, overridable per test.
	confinedRuntime: { resolve: undefined as undefined | (() => Promise<unknown>) },
}));

vi.mock('./env.js', () => ({ default: envState, getEnv: () => envState, refreshEnv: () => undefined }));

vi.mock('./extensions/confined/supervisor.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./extensions/confined/supervisor.js')>();

	const runtime = {
		wallClockMs: 5000,
		cpuTimeoutMs: 2000,
		memoryBytes: 64 * 1024 * 1024,
		stackBytes: 512 * 1024,
		acquireTimeoutMs: 0,
		hostCallTimeoutMs: 5000,
		maxHostCalls: 1000,
		maxInFlightHostCalls: 16,
	};

	const baseline = async () => ({
		ok: true,
		supervisor: { probeLoad: async () => ({ loadable: true }) },
		config: { sandbox: { maxArtifactBytes: 8 * 1024 * 1024 }, runtime },
		posture: {
			mode: 'auto',
			applied: [],
			missing: ['network-namespace', 'permission-model', 'cgroup-memory'],
			coreSatisfied: false,
			decision: 'run',
			cgroupMechanic: null,
		},
	});

	return { ...actual, resolveConfinedRuntime: () => (confinedRuntime.resolve ?? baseline)() };
});

// The internal-operations loop reads its directory with a template-literal dynamic
// import that the test bundler cannot resolve. Skipping that read lets the test
// exercise the extension-operations lane, which is the path under test.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, readdir: async () => [] };
});

import { ExtensionManager } from './extensions.js';
import logger from './logger.js';
import { filterServerExtensions } from './utils/filter-server-extensions.js';

let root: string;

function writeThrowingEntry(dir: string, file: string, marker: string): void {
	const full = path.join(root, dir);
	mkdirSync(full, { recursive: true });
	writeFileSync(path.join(full, file), `throw new Error(${JSON.stringify(marker)});\n`);
}

/**
 * A complete confined endpoint package the load gate can read: a valid manifest
 * declaring the confined runtime plus the declared source file.
 */
function writeConfinedPackage(dir: string, source: string, name = dir, capabilities?: Record<string, unknown>): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type: 'endpoint',
				path: 'index.js',
				source: 'src/index.js',
				runtime: 'confined-server',
				host: '^10.0.0',
				...(capabilities && { capabilities }),
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'index.js'), source);
}

/**
 * A complete confined operation package: a hybrid manifest, clean app and api
 * source, and a built api entry whose config id equals the extension name.
 */
function writeConfinedOperationPackage(dir: string, name = dir): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type: 'operation',
				path: { app: 'app.js', api: 'api.js' },
				source: { app: 'src/app.js', api: 'src/api.js' },
				runtime: 'confined-server',
				host: '^10.0.0',
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'app.js'), 'export default {};\n');
	writeFileSync(path.join(full, 'src', 'api.js'), 'export default {};\n');

	writeFileSync(
		path.join(full, 'api.js'),
		`var CairnOperation = (() => { const handler = async () => ({ ok: true }); return { default: { id: ${JSON.stringify(
			name
		)}, handler } }; })();\n`
	);
}

/**
 * A complete confined bundle package with one server entry and the given server
 * entry source, matching the discovered bundle shape.
 */
function writeConfinedBundlePackage(dir: string, serverEntrySource: string, name = dir): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type: 'bundle',
				path: { app: 'app.js', api: 'api.js' },
				entries: [{ type: 'endpoint', name: `${name}-endpoint`, source: 'src/ep.js' }],
				runtime: 'confined-server',
				host: '^10.0.0',
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'ep.js'), serverEntrySource);
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
	writeConfinedPackage('confined-endpoint', 'export default {};\n');
	writeConfinedPackage('flagged-endpoint', "import { readFile } from 'node:fs/promises';\nexport default {};\n");
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
		const confined = endpointExtension('confined-endpoint', 'confined-endpoint', true);

		(instance as any).getExtensions = async () => [
			confined,
			endpointExtension('control-endpoint', 'control-endpoint', false),
		];

		await (instance as any).load();

		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.find((entry: any) => entry.name === 'control-endpoint')?.status).toBe('failed');
		expect(diagnostics.map((entry: any) => entry.name)).not.toContain('confined-endpoint');
		expect((instance as any).confinedEligible.has(confined)).toBe(true);
	});
});

describe('the confined load gate in the loader', () => {
	it('refuses a flagged confined extension into diagnostics without leaking a path', async () => {
		const instance = new ExtensionManager();
		const flagged = endpointExtension('flagged-endpoint', 'flagged-endpoint', true);
		(instance as any).getExtensions = async () => [flagged];

		await (instance as any).load();

		const diagnostics = (instance as any).getDiagnostics();
		const row = diagnostics.find((entry: any) => entry.name === 'flagged-endpoint');

		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('uses-raw-fs');
		expect((instance as any).confinedEligible.has(flagged)).toBe(false);
		expect(JSON.stringify(diagnostics)).not.toContain(root);
	});

	it('admits a passing confined extension to the eligible set with no diagnostic row', async () => {
		const instance = new ExtensionManager();
		const confined = endpointExtension('confined-endpoint', 'confined-endpoint', true);
		(instance as any).getExtensions = async () => [confined];

		await (instance as any).load();

		expect((instance as any).confinedEligible.has(confined)).toBe(true);
		expect((instance as any).getDiagnostics()).toHaveLength(0);
	});

	it('carries the gate-validated capabilities into the eligible entry', async () => {
		const capabilities = { log: true, request: { urls: ['https://api.example.com'] } };
		writeConfinedPackage('capable-endpoint', 'export default {};\n', 'capable-endpoint', capabilities);

		const instance = new ExtensionManager();
		const capable = endpointExtension('capable-endpoint', 'capable-endpoint', true);
		(instance as any).getExtensions = async () => [capable];

		await (instance as any).load();

		expect((instance as any).confinedEligible.get(capable)).toEqual({ capabilities });
	});

	it('keeps same-name extensions distinct, so a failing one is never eligible through a passing one', async () => {
		writeConfinedPackage('dup-clean', 'export default {};\n', 'duplicate-name');

		writeConfinedPackage(
			'dup-flagged',
			"import { readFile } from 'node:fs/promises';\nexport default {};\n",
			'duplicate-name'
		);

		const instance = new ExtensionManager();
		const passing = endpointExtension('dup-clean', 'duplicate-name', true);
		const failing = endpointExtension('dup-flagged', 'duplicate-name', true);
		(instance as any).getExtensions = async () => [passing, failing];

		await (instance as any).load();

		expect((instance as any).confinedEligible.has(passing)).toBe(true);
		expect((instance as any).confinedEligible.has(failing)).toBe(false);

		const diagnostics = (instance as any).getDiagnostics();
		expect(diagnostics.some((entry: any) => entry.name === 'duplicate-name' && entry.status === 'failed')).toBe(true);
	});

	it('recomputes the verdict at reload, so a stale eligibility does not survive', async () => {
		writeConfinedPackage('mutable-endpoint', 'export default {};\n');

		const instance = new ExtensionManager();
		const mutable = endpointExtension('mutable-endpoint', 'mutable-endpoint', true);
		(instance as any).getExtensions = async () => [mutable];

		await (instance as any).load();
		expect((instance as any).confinedEligible.has(mutable)).toBe(true);

		writeConfinedPackage('mutable-endpoint', "import { readFile } from 'node:fs/promises';\nexport default {};\n");

		await (instance as any).load();

		expect((instance as any).confinedEligible.has(mutable)).toBe(false);

		expect((instance as any).getDiagnostics().find((entry: any) => entry.name === 'mutable-endpoint')?.status).toBe(
			'failed'
		);
	});

	it('unload clears the eligible set', async () => {
		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('confined-endpoint', 'confined-endpoint', true)];

		await (instance as any).load();
		expect((instance as any).confinedEligible.size).toBe(1);

		await (instance as any).unload();
		expect((instance as any).confinedEligible.size).toBe(0);
	});

	it('probes confined operations sequentially and carries the probed bytes into the eligible set', async () => {
		writeConfinedOperationPackage('op-one');
		writeConfinedOperationPackage('op-two');

		const instance = new ExtensionManager();
		const one = operationExtension('op-one', 'op-one', true);
		const two = operationExtension('op-two', 'op-two', true);
		(instance as any).getExtensions = async () => [one, two];

		await (instance as any).load();

		const eligible = (instance as any).confinedEligible;
		expect(eligible.get(one)?.entrySource).toContain('CairnOperation');
		expect(eligible.get(two)?.entrySource).toContain('CairnOperation');
		expect((instance as any).getDiagnostics()).toHaveLength(0);
	}, 30_000);

	it('refuses a confined bundle with flagged server source while it stays available to the app pipeline', async () => {
		writeConfinedBundlePackage('flagged-bundle', "import { readFile } from 'node:fs/promises';\nexport default {};\n");

		const instance = new ExtensionManager();
		const bundle = bundleExtension('flagged-bundle', 'flagged-bundle', true);
		(instance as any).getExtensions = async () => [bundle];

		await (instance as any).load();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'flagged-bundle');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('uses-raw-fs');
		expect((instance as any).confinedEligible.has(bundle)).toBe(false);

		// The discovered set feeds the app bundler, so the refusal of the server side
		// does not remove the package from it.
		expect((instance as any).extensions).toContain(bundle);
		expect(filterServerExtensions((instance as any).extensions)).not.toContain(bundle);
	});

	it('fails closed on a throwing probe without aborting the load of other extensions', async () => {
		writeConfinedOperationPackage('probe-thrower');

		const instance = new ExtensionManager();
		const operation = operationExtension('probe-thrower', 'probe-thrower', true);
		const sibling = endpointExtension('confined-endpoint', 'confined-endpoint', true);
		(instance as any).getExtensions = async () => [operation, sibling];

		(instance as any).confinedGateDeps = {
			probe: async () => {
				throw new Error('host went away');
			},
		};

		await (instance as any).load();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'probe-thrower');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('validation-incomplete');
		expect((instance as any).confinedEligible.has(operation)).toBe(false);
		expect((instance as any).confinedEligible.has(sibling)).toBe(true);
	});

	it('surfaces a host-side probe failure as validation-incomplete, not a verdict on the extension', async () => {
		writeConfinedOperationPackage('probe-unlucky');

		const instance = new ExtensionManager();
		const operation = operationExtension('probe-unlucky', 'probe-unlucky', true);
		(instance as any).getExtensions = async () => [operation];

		(instance as any).confinedGateDeps = {
			probe: async () => ({ loadable: false, error: { code: 'internal', message: 'the confined runtime failed' } }),
		};

		await (instance as any).load();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'probe-unlucky');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('validation-incomplete');
		expect((instance as any).confinedEligible.has(operation)).toBe(false);
	});
});

describe('the confined runtime boot', () => {
	afterEach(() => {
		confinedRuntime.resolve = undefined;
		vi.restoreAllMocks();
	});

	it('resolves the runtime only when a confined extension is present', async () => {
		const resolve = vi.fn(async () => ({ ok: false, error: { message: 'should not be called' } }));
		confinedRuntime.resolve = resolve;

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('plain', 'plain', false)];

		await (instance as any).load();

		expect(resolve).not.toHaveBeenCalled();
	});

	it('fails a confined extension closed when the runtime cannot be resolved, skipping the gate', async () => {
		// The package is clean, so it would be eligible if the gate ran. The runtime
		// failure must refuse it instead, proving the gate is skipped.
		writeConfinedPackage('boot-clean', 'export default {};\n');

		confinedRuntime.resolve = async () => ({
			ok: false,
			error: { envVar: 'EXTENSIONS_SANDBOX_MAX_MEMORY', message: 'EXTENSIONS_SANDBOX_MAX_MEMORY is invalid' },
		});

		const instance = new ExtensionManager();
		const confined = endpointExtension('boot-clean', 'boot-clean', true);
		(instance as any).getExtensions = async () => [confined];

		await (instance as any).load();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'boot-clean');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('validation-incomplete');
		expect((instance as any).confinedEligible.has(confined)).toBe(false);
		expect(JSON.stringify((instance as any).getDiagnostics())).not.toContain(root);
	});

	it('keeps an inherited extension untouched when the confined runtime fails', async () => {
		confinedRuntime.resolve = async () => ({ ok: false, error: { message: 'runtime down' } });

		const instance = new ExtensionManager();
		const confined = endpointExtension('confined-endpoint', 'confined-endpoint', true);
		const plain = endpointExtension('plain-endpoint', 'plain-endpoint', false);
		(instance as any).getExtensions = async () => [confined, plain];

		await (instance as any).load();

		const diagnostics = (instance as any).getDiagnostics();

		// The confined extension is failed by the runtime; the inherited one follows its
		// own registration path, never failed by the confined runtime's unavailability.
		expect(diagnostics.find((entry: any) => entry.name === 'confined-endpoint')?.reason?.code).toBe(
			'validation-incomplete'
		);

		expect((instance as any).isLoaded).toBe(true);
	});

	it('logs the resolved posture once per load', async () => {
		const info = vi.spyOn(logger, 'info');
		writeConfinedPackage('boot-posture', 'export default {};\n');

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('boot-posture', 'boot-posture', true)];

		await (instance as any).load();

		const postureLogs = info.mock.calls.filter((call) => String(call[0]).includes('confined OS hardening'));
		expect(postureLogs).toHaveLength(1);
	});
});
