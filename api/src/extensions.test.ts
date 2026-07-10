import type { Extension } from '@cairncms/types';
import { mkdirSync, writeFileSync } from 'node:fs';
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
			// Echoes the shaped input per contract so binding tests can assert what
			// reached the child.
			invoke: async (invocation: { activation?: string; input: unknown }) => {
				if (invocation.activation === 'event-filter') {
					return { ok: true, value: { unchanged: false, payload: { echoed: invocation.input } } };
				}

				if (invocation.activation === 'event-action') {
					return { ok: true, value: { done: true } };
				}

				return { ok: true, value: { status: 200, body: { echoed: invocation.input } } };
			},
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
import {
	bundleExtension,
	cleanupExtensionFixtures,
	createExtensionFixtures,
	endpointExtension,
	operationExtension,
	writeConfinedBundlePackage,
	writeConfinedOperationPackage,
	writeConfinedPackage,
} from './__utils__/extensions-fixtures.js';

let root: string;

beforeAll(() => {
	root = createExtensionFixtures();
	envState['EXTENSIONS_PATH'] = root;
});

afterAll(() => {
	cleanupExtensionFixtures();
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
		expect(row?.reason?.code).toBe('USES_RAW_FS');
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

	it('carries the per-entry bundle capabilities and hook events into the eligible entry', async () => {
		const dir = path.join(root, 'capable-bundle');
		mkdirSync(path.join(dir, 'src'), { recursive: true });

		writeFileSync(
			path.join(dir, 'package.json'),
			JSON.stringify({
				name: 'capable-bundle',
				version: '1.0.0',
				'cairncms:extension': {
					type: 'bundle',
					path: { app: 'app.js', api: 'api.js' },
					entries: [
						{ type: 'endpoint', name: 'ep', source: 'src/ep.js', capabilities: { log: true } },
						{ type: 'hook', name: 'hk', source: 'src/hk.js', events: { action: ['items.create'] } },
					],
					runtime: 'confined-server',
					host: '^10.0.0',
				},
			})
		);

		writeFileSync(path.join(dir, 'src', 'ep.js'), 'export default {};\n');
		writeFileSync(path.join(dir, 'src', 'hk.js'), 'export default {};\n');

		// The built bundle artifact the gate reads and probes; the mocked supervisor
		// answers the probe loadable, so its content is not validated here.
		const bundleArtifact =
			"var CairnBundle = (() => ({ default: { 'endpoint:ep': { id: 'ep', handler: async () => ({}) }, 'hook:hk': { id: 'hk', actions: { 'items.create': () => undefined } } } }))();\n";

		writeFileSync(path.join(dir, 'api.js'), bundleArtifact);

		const bundle: Extension = {
			path: dir,
			name: 'capable-bundle',
			type: 'bundle',
			entrypoint: { app: 'app.js', api: 'api.js' },
			entries: [
				{ type: 'endpoint', name: 'ep' },
				{ type: 'hook', name: 'hk' },
			],
			local: true,
			runtime: 'confined-server',
		};

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [bundle];

		await (instance as any).load();

		expect((instance as any).confinedEligible.get(bundle)).toEqual({
			entrySource: bundleArtifact,
			entryCapabilities: { 'endpoint:ep': { log: true } },
			entryEvents: { 'hook:hk': { action: ['items.create'] } },
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

	it('attaches capabilities to the eligible row, never a same-name failed sibling', async () => {
		writeConfinedPackage('dup-cap-clean', 'export default {};\n', 'duplicate-name', {
			endpoint: { access: 'public' },
			log: true,
		});

		writeConfinedPackage(
			'dup-cap-flagged',
			"import { readFile } from 'node:fs/promises';\nexport default {};\n",
			'duplicate-name'
		);

		const instance = new ExtensionManager();
		const passing = endpointExtension('dup-cap-clean', 'duplicate-name', true);
		const failing = endpointExtension('dup-cap-flagged', 'duplicate-name', true);
		(instance as any).getExtensions = async () => [passing, failing];

		await (instance as any).load();

		const rows = (instance as any).getDiagnostics().filter((entry: any) => entry.name === 'duplicate-name');
		expect(rows).toHaveLength(2);

		// A name-keyed join would put the eligible extension's capabilities on its gate-failed
		// same-name sibling too. The object-identity join keeps them on the eligible row only.
		const gateFailed = rows.find((row: any) => row.reason?.code === 'USES_RAW_FS');
		const eligible = rows.find((row: any) => row.reason?.code !== 'USES_RAW_FS');

		expect(gateFailed.capabilities).toBeUndefined();
		expect(eligible.capabilities).toEqual({ endpoint: { access: 'public' }, log: true });
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
		expect(row?.reason?.code).toBe('USES_RAW_FS');
		expect((instance as any).confinedEligible.has(bundle)).toBe(false);

		// The discovered set feeds the app bundler, so the refusal of the server side
		// does not remove the package from it.
		expect((instance as any).extensions).toContain(bundle);
		expect(filterServerExtensions((instance as any).extensions)).not.toContain(bundle);
	});

	it('fails closed on a throwing probe without aborting the load of other extensions', async () => {
		writeConfinedOperationPackage('probe-thrower');
		writeConfinedBundlePackage('probe-bundle-sibling', 'export default {};\n');

		const instance = new ExtensionManager();
		const operation = operationExtension('probe-thrower', 'probe-thrower', true);
		const endpointSibling = endpointExtension('confined-endpoint', 'confined-endpoint', true);
		const bundleSibling = bundleExtension('probe-bundle-sibling', 'probe-bundle-sibling', true);
		(instance as any).getExtensions = async () => [operation, endpointSibling, bundleSibling];

		(instance as any).confinedGateDeps = {
			probe: async () => {
				throw new Error('host went away');
			},
		};

		await (instance as any).load();

		// Every probed type, including the bundle, fails closed, and each is processed
		// (gets a diagnostic) rather than the loader aborting after the first throw.
		const diagnostics = (instance as any).getDiagnostics();

		for (const name of ['probe-thrower', 'confined-endpoint', 'probe-bundle-sibling']) {
			const row = diagnostics.find((entry: any) => entry.name === name);
			expect(row?.status, name).toBe('failed');
			expect(row?.reason?.code, name).toBe('VALIDATION_INCOMPLETE');
		}

		expect((instance as any).confinedEligible.has(operation)).toBe(false);
		expect((instance as any).confinedEligible.has(endpointSibling)).toBe(false);
		expect((instance as any).confinedEligible.has(bundleSibling)).toBe(false);
	});

	it('surfaces a host-side probe failure as VALIDATION_INCOMPLETE, not a verdict on the extension', async () => {
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
		expect(row?.reason?.code).toBe('VALIDATION_INCOMPLETE');
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

	it('reports not-required confined runtime metadata when no confined extension is present', async () => {
		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('plain', 'plain', false)];

		await (instance as any).load();

		expect((instance as any).getConfinedRuntimeMeta()).toEqual({ state: 'not-required', posture: null });
	});

	it('reports the resolved posture as available confined runtime metadata', async () => {
		writeConfinedPackage('meta-available', 'export default {};\n');

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('meta-available', 'meta-available', true)];

		await (instance as any).load();

		// The summary is exactly the operator-facing fields, never `coreSatisfied`.
		expect((instance as any).getConfinedRuntimeMeta()).toEqual({
			state: 'available',
			posture: {
				mode: 'auto',
				decision: 'run',
				applied: [],
				missing: ['network-namespace', 'permission-model', 'cgroup-memory'],
				cgroupMechanic: null,
			},
		});
	});

	it('reports unavailable confined runtime metadata when the runtime fails to resolve', async () => {
		confinedRuntime.resolve = async () => ({ ok: false, error: { message: 'runtime down' } });

		writeConfinedPackage('meta-unavailable', 'export default {};\n');

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [endpointExtension('meta-unavailable', 'meta-unavailable', true)];

		await (instance as any).load();

		expect((instance as any).getConfinedRuntimeMeta()).toEqual({ state: 'unavailable', posture: null });
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
		expect(row?.reason?.code).toBe('VALIDATION_INCOMPLETE');
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
			'VALIDATION_INCOMPLETE'
		);

		// A failed confined extension still carries its runtime marker.
		expect(diagnostics.find((entry: any) => entry.name === 'confined-endpoint')?.runtime).toBe('confined-server');

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

describe('app-extension settings ownership is independent of SERVE_APP', () => {
	it('owns settings with SERVE_APP off while staying out of the served set', async () => {
		const instance = new ExtensionManager();

		const appExtension: Extension = {
			path: path.join(root, 'preview-module'),
			name: 'cairncms-extension-preview',
			type: 'module',
			entrypoint: 'app.js',
			local: true,
			settings: { theme: { type: 'string', scope: 'global', appReadable: true } },
		};

		(instance as any).getExtensions = async () => [appExtension];

		await (instance as any).load();

		expect((instance as any).getSettingsOwner('cairncms-extension-preview')).toBe(appExtension);
		expect((instance as any).getExtensionsList('module')).toEqual([]);
	});

	it('lists the app-only owner as a discovered row with its settings status', async () => {
		const instance = new ExtensionManager();

		const appExtension: Extension = {
			path: path.join(root, 'preview-module'),
			name: 'cairncms-extension-preview',
			type: 'module',
			entrypoint: 'app.js',
			local: true,
			settings: { theme: { type: 'string', scope: 'global', appReadable: true } },
		};

		(instance as any).getExtensions = async () => [appExtension];

		await (instance as any).load();

		const row = instance.getDiagnostics().find((diagnostic) => diagnostic.name === 'cairncms-extension-preview');
		expect(row).toMatchObject({ type: 'module', status: 'discovered', settings: { status: 'available' } });

		const owners = instance.getSettingsOwners();

		expect(owners).toEqual([
			{
				subject: 'cairncms-extension-preview',
				displaySubject: 'cairncms-extension-preview',
				status: 'available',
				declaration: { theme: { type: 'string', scope: 'global', appReadable: true } },
			},
		]);
	});
});

describe('the settings subject gate in the loader', () => {
	const declaration = { preview_url: { type: 'string', scope: 'global' } } as any;

	function settingsOwner(dir: string, name: string): Extension {
		return { ...endpointExtension(dir, name, false), settings: declaration };
	}

	it('marks a valid unique settings owner eligible without removing it from the load', async () => {
		const instance = new ExtensionManager();
		const owner = settingsOwner('preview', 'cairncms-extension-preview');
		(instance as any).getExtensions = async () => [owner];

		await (instance as any).load();

		expect((instance as any).isSettingsEligible(owner)).toBe(true);
		expect((instance as any).extensions).toContain(owner);
	});

	it('refuses an invalid settings subject without failing the extension, warning instead', async () => {
		const warn = vi.spyOn(logger, 'warn');
		const instance = new ExtensionManager();
		const owner = settingsOwner('bad', 'bad-subject');
		(instance as any).getExtensions = async () => [owner];

		await (instance as any).load();

		expect((instance as any).isSettingsEligible(owner)).toBe(false);
		expect((instance as any).extensions).toContain(owner);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad-subject'));
	});

	it('refuses every owner on a subject collision', async () => {
		const instance = new ExtensionManager();
		const first = settingsOwner('dup-a', 'cairncms-extension-dup');
		const second = settingsOwner('dup-b', 'cairncms-extension-dup');
		(instance as any).getExtensions = async () => [first, second];

		await (instance as any).load();

		expect((instance as any).isSettingsEligible(first)).toBe(false);
		expect((instance as any).isSettingsEligible(second)).toBe(false);
	});

	it('keeps the surviving owner ineligible when its same-name twin fails to load', async () => {
		writeConfinedPackage('dup-set-clean', 'export default {};\n', 'cairncms-extension-dup');

		writeConfinedPackage(
			'dup-set-flagged',
			"import { readFile } from 'node:fs/promises';\nexport default {};\n",
			'cairncms-extension-dup'
		);

		const instance = new ExtensionManager();
		const loading = { ...endpointExtension('dup-set-clean', 'cairncms-extension-dup', true), settings: declaration };
		const failing = { ...endpointExtension('dup-set-flagged', 'cairncms-extension-dup', true), settings: declaration };
		(instance as any).getExtensions = async () => [loading, failing];

		await (instance as any).load();

		expect((instance as any).confinedEligible.has(loading)).toBe(true);
		expect((instance as any).confinedEligible.has(failing)).toBe(false);

		expect((instance as any).isSettingsEligible(loading)).toBe(false);
		expect((instance as any).getSettingsOwner('cairncms-extension-dup')).toBeUndefined();
	});

	it('exposes a gated-ineligible owner declaration through getDeclaredSettings for masking', async () => {
		const instance = new ExtensionManager();
		const first = settingsOwner('dup-a', 'cairncms-extension-dup');
		const second = settingsOwner('dup-b', 'cairncms-extension-dup');
		(instance as any).getExtensions = async () => [first, second];

		await (instance as any).load();

		expect((instance as any).getSettingsOwner('cairncms-extension-dup')).toBeUndefined();
		expect((instance as any).getDeclaredSettings('cairncms-extension-dup')).toEqual([declaration, declaration]);
		expect((instance as any).getDeclaredSettings('cairncms-extension-absent')).toEqual([]);
	});

	it('does not treat an extension without a settings declaration as an owner', async () => {
		const instance = new ExtensionManager();
		const plain = endpointExtension('plain-owner', 'cairncms-extension-plain', false);
		(instance as any).getExtensions = async () => [plain];

		await (instance as any).load();

		expect((instance as any).isSettingsEligible(plain)).toBe(false);
	});

	it('resolves the owner and eligibility by identity, not by a shared name', async () => {
		const instance = new ExtensionManager();
		const owner = settingsOwner('shared-owner', 'cairncms-extension-shared');
		const nonOwner = endpointExtension('shared-plain', 'cairncms-extension-shared', false);
		(instance as any).getExtensions = async () => [owner, nonOwner];

		await (instance as any).load();

		expect((instance as any).isSettingsEligible(owner)).toBe(true);
		expect((instance as any).isSettingsEligible(nonOwner)).toBe(false);
		expect((instance as any).getSettingsOwner('cairncms-extension-shared')).toBe(owner);
		expect((instance as any).getSettingsOwner('cairncms-extension-absent')).toBeUndefined();
	});

	it('annotates every owner row with its settings status, by identity', async () => {
		const instance = new ExtensionManager();
		const first = settingsOwner('dup-a', 'cairncms-extension-dup');
		const second = settingsOwner('dup-b', 'cairncms-extension-dup');
		const nonOwner = endpointExtension('dup-plain', 'cairncms-extension-dup', false);
		(instance as any).getExtensions = async () => [first, second, nonOwner];

		await (instance as any).load();

		const rows = instance.getDiagnostics().filter((diagnostic) => diagnostic.name === 'cairncms-extension-dup');
		const annotated = rows.filter((row) => row.settings !== undefined);

		expect(rows.length).toBe(3);
		expect(annotated.length).toBe(2);

		for (const row of annotated) {
			expect(row.settings).toMatchObject({
				status: 'unavailable',
				reason: { code: 'SETTINGS_SUBJECT_DUPLICATE' },
			});
		}
	});

	it('returns owners with the raw subject and declaration only when available', async () => {
		const instance = new ExtensionManager();
		const good = settingsOwner('preview', 'cairncms-extension-preview');
		const bad = settingsOwner('bad', 'bad-subject');
		(instance as any).getExtensions = async () => [good, bad];

		await (instance as any).load();

		const owners = instance.getSettingsOwners();
		expect(owners.length).toBe(2);

		const available = owners.find((owner) => owner.status === 'available');

		expect(available).toEqual({
			subject: 'cairncms-extension-preview',
			displaySubject: 'cairncms-extension-preview',
			status: 'available',
			declaration,
		});

		const unavailable = owners.find((owner) => owner.status === 'unavailable');
		expect(unavailable?.displaySubject).toBe('bad-subject');
		expect(unavailable && 'subject' in unavailable).toBe(false);
		expect(unavailable && 'declaration' in unavailable).toBe(false);
		expect(unavailable?.reason?.code).toBe('SETTINGS_SUBJECT_INVALID');
	});

	it('keeps the derived config variable out of every public surface on a collision', async () => {
		const warn = vi.spyOn(logger, 'warn');
		const instance = new ExtensionManager();

		const configSettings = { api_key: { type: 'string', scope: 'global', secret: { source: 'config' } } } as any;
		const first = { ...endpointExtension('edge-a', 'cairncms-extension-edge-sync', false), settings: configSettings };
		const second = { ...endpointExtension('edge-b', 'cairncms-extension-edge.sync', false), settings: configSettings };
		(instance as any).getExtensions = async () => [first, second];

		await (instance as any).load();

		const owners = instance.getSettingsOwners();
		expect(owners.every((owner) => owner.status === 'unavailable')).toBe(true);
		expect(owners.every((owner) => owner.reason?.code === 'SETTINGS_SUBJECT_CONFIG_COLLISION')).toBe(true);

		expect(JSON.stringify(owners)).not.toContain('CAIRNCMS_EXT_');
		expect(JSON.stringify(instance.getDiagnostics())).not.toContain('CAIRNCMS_EXT_');

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('CAIRNCMS_EXT_'));
	});
});
