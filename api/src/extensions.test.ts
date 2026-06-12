import type { Extension } from '@cairncms/types';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
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

// registerEndpoint and its siblings build their register context eagerly, and the
// real getDatabase exits the process when the test env declares no database.
vi.mock('./database/index.js', () => ({ default: () => ({}) }));

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
		supervisor: {
			probeLoad: async () => ({ loadable: true }),
			// Echoes the shaped input so binding tests can assert what reached the child.
			invoke: async (invocation: { input: unknown }) => ({
				ok: true,
				value: { status: 200, body: { echoed: invocation.input } },
			}),
		},
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
import { getFlowManager } from './flows.js';
import logger from './logger.js';
import { filterServerExtensions } from './utils/filter-server-extensions.js';

let root: string;

function writeThrowingEntry(dir: string, file: string, marker: string): void {
	const full = path.join(root, dir);
	mkdirSync(full, { recursive: true });
	writeFileSync(path.join(full, file), `throw new Error(${JSON.stringify(marker)});\n`);
}

/**
 * A complete confined endpoint or hook package the load gate can read: a valid
 * manifest declaring the confined runtime, the declared source file, and for an
 * endpoint a built entry. The built entry doubles as the never-imported canary:
 * it throws a marker under Node, where `process` exists, while the probe's
 * QuickJS guest sees a valid CairnEndpoint config.
 */
function writeConfinedPackage(
	dir: string,
	source: string,
	name = dir,
	capabilities?: Record<string, unknown>,
	type: 'endpoint' | 'hook' = 'endpoint'
): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type,
				path: 'index.js',
				source: 'src/index.js',
				runtime: 'confined-server',
				host: '^10.0.0',
				...(capabilities && { capabilities }),
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'index.js'), source);

	if (type === 'endpoint') {
		writeFileSync(
			path.join(full, 'index.js'),
			`if (typeof process !== 'undefined') { throw new Error('CONFINED_ENDPOINT_IMPORTED'); }\n` +
				`var CairnEndpoint = (() => { const handler = async () => ({ body: null }); return { default: { id: ${JSON.stringify(
					name
				)}, handler } }; })();\n`
		);
	}
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

	writeConfinedPackage('confined-endpoint', 'export default {};\n', 'confined-endpoint', {
		endpoint: { access: 'public' },
	});

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
		expect(diagnostics.find((entry: any) => entry.name === 'confined-endpoint')?.status).toBe('loaded');
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

	it('admits a passing confined extension with no gate-time row, then registers it as loaded', async () => {
		const instance = new ExtensionManager();
		const confined = endpointExtension('confined-endpoint', 'confined-endpoint', true);
		(instance as any).getExtensions = async () => [confined];

		await (instance as any).load();

		expect((instance as any).confinedEligible.has(confined)).toBe(true);

		const diagnostics = (instance as any).getDiagnostics();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ name: 'confined-endpoint', status: 'loaded' });
	});

	it('carries the gate-validated capabilities into the eligible entry', async () => {
		const capabilities = { log: true, request: { urls: ['https://api.example.com'] } };
		writeConfinedPackage('capable-endpoint', 'export default {};\n', 'capable-endpoint', capabilities);

		const instance = new ExtensionManager();
		const capable = endpointExtension('capable-endpoint', 'capable-endpoint', true);
		(instance as any).getExtensions = async () => [capable];

		await (instance as any).load();

		expect((instance as any).confinedEligible.get(capable)).toEqual({
			capabilities,
			entrySource: expect.stringContaining('CairnEndpoint'),
		});
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

		// Both pass the gate with no gate-time row, then register as loaded operations.
		const diagnostics = (instance as any).getDiagnostics();

		expect(diagnostics.map((entry: any) => `${entry.name}:${entry.status}`).sort()).toEqual([
			'op-one:loaded',
			'op-two:loaded',
		]);
	}, 30_000);

	it('fails a duplicate confined operation id and rejects a flow that references it', async () => {
		writeConfinedOperationPackage('dup-a', 'dup-op');
		writeConfinedOperationPackage('dup-b', 'dup-op');

		const flowManager = getFlowManager();
		flowManager.clearConfinedOperations();

		const instance = new ExtensionManager();

		(instance as any).getExtensions = async () => [
			operationExtension('dup-a', 'dup-op', true),
			operationExtension('dup-b', 'dup-op', true),
		];

		await (instance as any).load();

		const failed = (instance as any)
			.getDiagnostics()
			.filter((entry: any) => entry.name === 'dup-op' && entry.status === 'failed');

		expect(failed).toHaveLength(2);

		// The id is marked ambiguous in the flow manager, so a flow rejects rather than
		// taking the missing-operation unknown path.
		const flow = {
			id: 'f',
			name: 'f',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: { id: 'op-x', key: 'step', type: 'dup-op', options: {}, resolve: null, reject: null },
		};

		const result = await (flowManager as any).executeFlow(
			flow,
			{ x: 1 },
			{
				accountability: null,
				database: {},
				schema: { collections: {}, relations: [] },
			}
		);

		expect(result).toMatchObject({ message: expect.stringContaining('could not be resolved') });
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
		writeConfinedPackage('probe-hook-sibling', 'export default {};\n', 'probe-hook-sibling', undefined, 'hook');

		const instance = new ExtensionManager();
		const operation = operationExtension('probe-thrower', 'probe-thrower', true);
		const endpointSibling = endpointExtension('confined-endpoint', 'confined-endpoint', true);
		const hookSibling = hookExtension('probe-hook-sibling', 'probe-hook-sibling', true);
		(instance as any).getExtensions = async () => [operation, endpointSibling, hookSibling];

		(instance as any).confinedGateDeps = {
			probe: async () => {
				throw new Error('host went away');
			},
		};

		await (instance as any).load();

		// Both probed types fail closed; the scanner-gated hook is untouched.
		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'probe-thrower');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('validation-incomplete');
		expect((instance as any).confinedEligible.has(operation)).toBe(false);
		expect((instance as any).confinedEligible.has(endpointSibling)).toBe(false);
		expect((instance as any).confinedEligible.has(hookSibling)).toBe(true);
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

describe('the confined endpoint binding', () => {
	const PUBLIC_CALLER = { user: null, role: null, admin: false };

	function endpointApp(instance: ExtensionManager, accountability: unknown = PUBLIC_CALLER) {
		const app = express();
		app.use(express.json());

		app.use((req, _res, next) => {
			(req as any).accountability = accountability;
			next();
		});

		app.use(instance.getEndpointRouter());

		app.use((err: any, _req: any, res: any, _next: any) => {
			res.status(err.status ?? 500).json({ code: err.code ?? 'INTERNAL' });
		});

		return app;
	}

	async function loadedManager(extensions: Extension[]): Promise<ExtensionManager> {
		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => extensions;
		await (instance as any).load();
		return instance;
	}

	it('mounts an eligible confined endpoint and serves the shaped request without importing it', async () => {
		writeConfinedPackage('served-endpoint', 'export default {};\n', 'served-endpoint', {
			endpoint: { access: 'public' },
		});

		const instance = await loadedManager([endpointExtension('served-endpoint', 'served-endpoint', true)]);

		const response = await supertest(endpointApp(instance))
			.post('/served-endpoint/charge')
			.query({ dry: 'true' })
			.send({ amount: 12 });

		expect(response.status).toBe(200);

		expect(response.body.echoed).toEqual({
			method: 'POST',
			path: '/charge',
			query: { dry: 'true' },
			body: { amount: 12 },
		});

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'served-endpoint');
		expect(row?.status).toBe('loaded');
	});

	it('requires a user under authenticated access and serves one', async () => {
		writeConfinedPackage('auth-endpoint', 'export default {};\n', 'auth-endpoint', {
			endpoint: { access: 'authenticated' },
		});

		const instance = await loadedManager([endpointExtension('auth-endpoint', 'auth-endpoint', true)]);

		const anonymous = await supertest(endpointApp(instance)).get('/auth-endpoint/');
		expect(anonymous.status).toBe(401);

		const authenticated = await supertest(endpointApp(instance, { user: 'u-1', role: 'r-1', admin: false })).get(
			'/auth-endpoint/'
		);

		expect(authenticated.status).toBe(200);
	});

	it('fails closed on a route collision with an already registered endpoint', async () => {
		writeConfinedPackage('colliding-endpoint', 'export default {};\n', 'colliding-endpoint', {
			endpoint: { access: 'public' },
		});

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('colliding-endpoint', 'colliding-endpoint', true)];

		const originalRegister = (instance as any).registerEndpoints.bind(instance);

		(instance as any).registerEndpoints = async () => {
			await originalRegister();
			(instance as any).registeredEndpointRoutes.add('colliding-endpoint');
		};

		await (instance as any).load();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'colliding-endpoint');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('route-collision');

		const response = await supertest(endpointApp(instance)).get('/colliding-endpoint/');
		expect(response.status).toBe(404);
	});

	it('refuses a route name that is not a safe literal, so a pattern cannot shadow other routes', async () => {
		for (const [dir, name] of [
			['evil-param-endpoint', 'evil-:id'],
			['evil-wildcard-endpoint', 'evil-*'],
			['evil-group-endpoint', 'evil-(x)'],
			['evil-case-endpoint', 'Evil-Case'],
		] as const) {
			writeConfinedPackage(dir, 'export default {};\n', name, { endpoint: { access: 'public' } });

			const instance = await loadedManager([endpointExtension(dir, name, true)]);

			const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === name);
			expect(row?.status, name).toBe('failed');
			expect(row?.reason?.code, name).toBe('route-invalid');

			// The pattern a parameterized name would have mounted must match nothing.
			const probe = await supertest(endpointApp(instance)).get('/evil-anything/');
			expect(probe.status, name).toBe(404);
		}
	});

	it('collides case-insensitively with an inherited route instead of shadowing it', async () => {
		writeConfinedPackage('cased-endpoint', 'export default {};\n', 'cased-route', {
			endpoint: { access: 'public' },
		});

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('cased-endpoint', 'cased-route', true)];

		const originalRegister = (instance as any).registerEndpoints.bind(instance);

		(instance as any).registerEndpoints = async () => {
			await originalRegister();
			// An inherited endpoint registered under a case variant of the same route.
			(instance as any).registerEndpoint(() => undefined, 'CASED-Route');
		};

		await (instance as any).load();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'cased-route');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('route-collision');
	});

	it('fails both confined endpoints that declare the same route', async () => {
		writeConfinedPackage('dup-endpoint-a', 'export default {};\n', 'dup-endpoint', { endpoint: { access: 'public' } });
		writeConfinedPackage('dup-endpoint-b', 'export default {};\n', 'dup-endpoint', { endpoint: { access: 'public' } });

		const instance = await loadedManager([
			endpointExtension('dup-endpoint-a', 'dup-endpoint', true),
			endpointExtension('dup-endpoint-b', 'dup-endpoint', true),
		]);

		const failed = (instance as any)
			.getDiagnostics()
			.filter((entry: any) => entry.name === 'dup-endpoint' && entry.reason?.code === 'ambiguous-endpoint');

		expect(failed).toHaveLength(2);

		const response = await supertest(endpointApp(instance)).get('/dup-endpoint/');
		expect(response.status).toBe(404);
	});

	it('fails an endpoint that does not declare the endpoint capability', async () => {
		writeConfinedPackage('capless-endpoint', 'export default {};\n');

		const instance = await loadedManager([endpointExtension('capless-endpoint', 'capless-endpoint', true)]);

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'capless-endpoint');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('capability-missing');

		const response = await supertest(endpointApp(instance)).get('/capless-endpoint/');
		expect(response.status).toBe(404);
	});

	it('unload clears the confined route so a stale route cannot survive a reload', async () => {
		writeConfinedPackage('reload-endpoint', 'export default {};\n', 'reload-endpoint', {
			endpoint: { access: 'public' },
		});

		const instance = await loadedManager([endpointExtension('reload-endpoint', 'reload-endpoint', true)]);

		const before = await supertest(endpointApp(instance)).get('/reload-endpoint/');
		expect(before.status).toBe(200);

		await (instance as any).unload();

		const after = await supertest(endpointApp(instance)).get('/reload-endpoint/');
		expect(after.status).toBe(404);
	});

	it('maps a child failure to a sanitized platform error', async () => {
		confinedRuntime.resolve = async () => ({
			ok: true,
			supervisor: {
				probeLoad: async () => ({ loadable: true }),
				invoke: async () => ({ ok: false, error: { code: 'timeout', message: 'the json endpoint failed' } }),
			},
			config: {
				sandbox: { maxArtifactBytes: 8 * 1024 * 1024 },
				runtime: {
					wallClockMs: 5000,
					cpuTimeoutMs: 2000,
					memoryBytes: 64 * 1024 * 1024,
					stackBytes: 512 * 1024,
					acquireTimeoutMs: 0,
					hostCallTimeoutMs: 5000,
					maxHostCalls: 1000,
					maxInFlightHostCalls: 16,
				},
			},
			posture: {
				mode: 'auto',
				applied: [],
				missing: [],
				coreSatisfied: true,
				decision: 'run',
				cgroupMechanic: null,
			},
		});

		writeConfinedPackage('failing-endpoint', 'export default {};\n', 'failing-endpoint', {
			endpoint: { access: 'public' },
		});

		const instance = await loadedManager([endpointExtension('failing-endpoint', 'failing-endpoint', true)]);

		const response = await supertest(endpointApp(instance)).get('/failing-endpoint/');

		expect(response.status).toBe(500);
		expect(JSON.stringify(response.body)).not.toContain('timeout');

		confinedRuntime.resolve = undefined;
	});
});
