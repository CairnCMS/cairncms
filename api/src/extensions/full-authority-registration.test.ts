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

vi.mock('../env.js', () => ({ default: envState, getEnv: () => envState, refreshEnv: () => undefined }));

// registerEndpoint and its siblings build their register context eagerly, and the
// real getDatabase exits the process when the test env declares no database.
vi.mock('../database/index.js', () => ({ default: () => ({}) }));

vi.mock('./confined/supervisor.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./confined/supervisor.js')>();

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

import { ExtensionManager } from '../extensions.js';
import { getFlowManager } from '../flows.js';
import {
	bundleExtension,
	cleanupExtensionFixtures,
	createExtensionFixtures,
	endpointExtension,
	hookExtension,
	manager,
	operationExtension,
} from '../__utils__/extensions-fixtures.js';

let root: string;

beforeAll(() => {
	root = createExtensionFixtures();
	envState['EXTENSIONS_PATH'] = root;
});

afterAll(() => {
	cleanupExtensionFixtures();
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
		// A full-authority extension carries no runtime marker.
		expect(diagnostics.find((entry: any) => entry.name === 'control-endpoint')?.runtime).toBeUndefined();
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

describe('full-authority extension settings threading', () => {
	const SUBJECT = 'cairncms-extension-threaded';
	const CONFIG_VAR = 'CAIRNCMS_EXT_THREADED_BILLING_KEY';
	const BUNDLE_SUBJECT = 'cairncms-extension-fa-bundle';
	const BUNDLE_CONFIG_VAR = 'CAIRNCMS_EXT_FA_BUNDLE_BILLING_KEY';

	const configDecl = { billing_key: { type: 'string', scope: 'global', secret: { source: 'config' } } } as any;

	function seedOwner(instance: ExtensionManager, subject: string) {
		(instance as any).settingsEligible = new Set([{ name: subject, settings: configDecl }]);
	}

	afterEach(() => {
		delete process.env[CONFIG_VAR];
		delete process.env[BUNDLE_CONFIG_VAR];
		delete (globalThis as any).__faBundleHookContext;
		delete (globalThis as any).__faBundleEndpointContext;
		delete (globalThis as any).__faBundleOperationContext;
		getFlowManager().clearOperations();
		vi.restoreAllMocks();
	});

	it('binds a hook context reader to the registering subject', async () => {
		process.env[CONFIG_VAR] = 'hook-secret';
		const instance = new ExtensionManager();
		seedOwner(instance, SUBJECT);

		let captured: any;

		(instance as any).registerHook((_register: any, context: any) => {
			captured = context;
		}, SUBJECT);

		expect(await captured.extensionSettings.get('billing_key')).toBe('hook-secret');
		expect(await captured.extensionSettings.get('undeclared')).toBeNull();
	});

	it('binds an endpoint context reader to the registering subject', async () => {
		process.env[CONFIG_VAR] = 'endpoint-secret';
		const instance = new ExtensionManager();
		seedOwner(instance, SUBJECT);

		let captured: any;

		(instance as any).registerEndpoint(
			(_router: any, context: any) => {
				captured = context;
			},
			'threaded-endpoint',
			SUBJECT
		);

		expect(await captured.extensionSettings.get('billing_key')).toBe('endpoint-secret');
	});

	it('wraps an extension operation handler with a bound reader and leaves an internal one unwrapped', async () => {
		const flowManager = getFlowManager();
		const spy = vi.spyOn(flowManager, 'addOperation');
		const instance = new ExtensionManager();
		seedOwner(instance, SUBJECT);

		let captured: any;

		const handler = (_options: any, context: any) => {
			captured = context;
			return null;
		};

		(instance as any).registerOperation({ id: 'threaded-op-16-7', handler }, SUBJECT);

		const wrapped = spy.mock.calls.at(-1)![1] as any;
		expect(wrapped).not.toBe(handler);

		process.env[CONFIG_VAR] = 'operation-secret';
		await wrapped({}, { data: { fed: true }, accountability: null });

		expect(captured.data).toEqual({ fed: true });
		expect(await captured.extensionSettings.get('billing_key')).toBe('operation-secret');

		(instance as any).registerOperation({ id: 'internal-op-16-7', handler });
		expect(spy.mock.calls.at(-1)![1]).toBe(handler);
	});

	it('binds bundle entry contexts to the bundle subject, not the entry name', async () => {
		process.env[BUNDLE_CONFIG_VAR] = 'bundle-secret';

		const dir = path.join(root, 'fa-bundle');
		mkdirSync(dir, { recursive: true });

		writeFileSync(
			path.join(dir, 'api.js'),
			'export default { hooks: [{ config: (_register, context) => { globalThis.__faBundleHookContext = context; } }], ' +
				"endpoints: [{ name: 'inner-endpoint', config: (_router, context) => { globalThis.__faBundleEndpointContext = context; } }], " +
				"operations: [{ config: { id: 'fa-bundle-op-16-7', handler: (_options, context) => { globalThis.__faBundleOperationContext = context; return null; } } }] };\n"
		);

		const flowManager = getFlowManager();
		const spy = vi.spyOn(flowManager, 'addOperation');

		const bundle = bundleExtension('fa-bundle', BUNDLE_SUBJECT, false);
		const instance = manager([bundle]);
		seedOwner(instance, BUNDLE_SUBJECT);

		await (instance as any).registerBundles();

		const hookContext = (globalThis as any).__faBundleHookContext;
		const endpointContext = (globalThis as any).__faBundleEndpointContext;

		expect(await hookContext.extensionSettings.get('billing_key')).toBe('bundle-secret');
		expect(await endpointContext.extensionSettings.get('billing_key')).toBe('bundle-secret');

		const registered = spy.mock.calls.find(([id]) => id === 'fa-bundle-op-16-7');
		expect(registered).toBeDefined();

		await (registered![1] as any)({}, { data: {}, accountability: null });

		const operationContext = (globalThis as any).__faBundleOperationContext;
		expect(await operationContext.extensionSettings.get('billing_key')).toBe('bundle-secret');
	});
});
