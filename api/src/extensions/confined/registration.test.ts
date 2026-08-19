import { RESERVED_EVENT_NAMESPACE_ERROR } from '@cairncms/constants';
import type { Extension } from '@cairncms/types';
import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
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

vi.mock('../../env.js', () => ({ default: envState, getEnv: () => envState, refreshEnv: () => undefined }));

// registerEndpoint and its siblings build their register context eagerly, and the
// real getDatabase exits the process when the test env declares no database.
vi.mock('../../database/index.js', () => ({ default: () => ({}) }));

vi.mock('./supervisor.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./supervisor.js')>();

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

import { ExtensionManager } from '../../extensions.js';
import emitter from '../../emitter.js';
import { getFlowManager } from '../../flows.js';
import logger from '../../logger.js';
import {
	cleanupExtensionFixtures,
	createExtensionFixtures,
	endpointExtension,
	hookExtension,
	operationExtension,
	writeConfinedOperationPackage,
	writeConfinedPackage,
} from '../../__utils__/extensions-fixtures.js';

let root: string;

beforeAll(() => {
	root = createExtensionFixtures();
	envState['EXTENSIONS_PATH'] = root;
});

afterAll(() => {
	cleanupExtensionFixtures();
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
		expect(row?.runtime).toBe('confined-server');
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
		expect(row?.reason?.code).toBe('ROUTE_COLLISION');

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
			expect(row?.reason?.code, name).toBe('ROUTE_INVALID');

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
		expect(row?.reason?.code).toBe('ROUTE_COLLISION');
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
			.filter((entry: any) => entry.name === 'dup-endpoint' && entry.reason?.code === 'AMBIGUOUS_ENDPOINT');

		expect(failed).toHaveLength(2);

		const response = await supertest(endpointApp(instance)).get('/dup-endpoint/');
		expect(response.status).toBe(404);
	});

	it('fails an endpoint that does not declare the endpoint capability', async () => {
		writeConfinedPackage('capless-endpoint', 'export default {};\n');

		const instance = await loadedManager([endpointExtension('capless-endpoint', 'capless-endpoint', true)]);

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'capless-endpoint');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('CAPABILITY_MISSING');

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

describe('the confined hook binding', () => {
	const EVENT_CONTEXT = { database: {} as never, schema: null, accountability: null };
	let current: ExtensionManager | undefined;

	afterEach(async () => {
		if (current !== undefined) await (current as any).unload();
		current = undefined;
		confinedRuntime.resolve = undefined;
	});

	async function loadedHookManager(dir: string, name: string, events: { filter?: string[]; action?: string[] }) {
		writeConfinedPackage(dir, 'export default {};\n', name, { log: true }, 'hook', events);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [hookExtension(dir, name, true)];
		await (instance as any).load();
		current = instance;
		return instance;
	}

	it('subscribes the manifest events and serves a filter through the emitter without importing', async () => {
		const instance = await loadedHookManager('filtering-hook', 'filtering-hook', {
			filter: ['confined-binding.filter'],
		});

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'filtering-hook');
		expect(row?.status).toBe('loaded');

		const result = await emitter.emitFilter('confined-binding.filter', { v: 1 }, { collection: 'c' }, EVENT_CONTEXT);

		// The baseline child stub echoes the shaped input back as the new payload.
		expect(result).toEqual({
			echoed: {
				event: 'confined-binding.filter',
				payload: { v: 1 },
				meta: { event: 'confined-binding.filter', collection: 'c' },
			},
		});
	});

	it('keeps the platform payload when the guest answers no-change', async () => {
		confinedRuntime.resolve = async () => ({
			ok: true,
			supervisor: {
				probeLoad: async () => ({ loadable: true }),
				invoke: async () => ({ ok: true, value: { unchanged: true } }),
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
			posture: { mode: 'auto', applied: [], missing: [], coreSatisfied: true, decision: 'run', cgroupMechanic: null },
		});

		await loadedHookManager('unchanged-hook', 'unchanged-hook', { filter: ['confined-binding.unchanged'] });

		const payload = { v: 1 };
		const result = await emitter.emitFilter('confined-binding.unchanged', payload, {}, EVENT_CONTEXT);

		expect(result).toBe(payload);
	});

	it('blocks the platform action with a sanitized error when a filter fails', async () => {
		confinedRuntime.resolve = async () => ({
			ok: true,
			supervisor: {
				probeLoad: async () => ({ loadable: true }),
				invoke: async () => {
					throw new Error('child exploded at /home/alison/secret');
				},
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
			posture: { mode: 'auto', applied: [], missing: [], coreSatisfied: true, decision: 'run', cgroupMechanic: null },
		});

		await loadedHookManager('failing-filter-hook', 'failing-filter-hook', { filter: ['confined-binding.failing'] });

		await expect(emitter.emitFilter('confined-binding.failing', { v: 1 }, {}, EVENT_CONTEXT)).rejects.toThrow(
			'the confined hook "failing-filter-hook" failed'
		);

		await expect(emitter.emitFilter('confined-binding.failing', { v: 1 }, {}, EVENT_CONTEXT)).rejects.not.toThrow(
			/secret/
		);
	});

	it('fires an action hook from the platform emitter and logs a failure without blocking', async () => {
		// A confined action hook has no production-observable sink (request is SSRF
		// gated, items is read-only), so its dispatch is proven here: the manifest
		// action event, emitted through the real platform emitter, drives the confined
		// runner, and a failure logs a sanitized warning without blocking the action.
		const invoke = vi.fn(async () => ({ ok: false, error: { code: 'timeout', message: 'the event hook failed' } }));

		confinedRuntime.resolve = async () => ({
			ok: true,
			supervisor: { probeLoad: async () => ({ loadable: true }), invoke },
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
			posture: { mode: 'auto', applied: [], missing: [], coreSatisfied: true, decision: 'run', cgroupMechanic: null },
		});

		await loadedHookManager('failing-action-hook', 'failing-action-hook', {
			action: ['confined-binding.action-fails'],
		});

		const warn = vi.spyOn(logger, 'warn');

		// emitAction is fire-and-forget: it returns without throwing, which is the
		// non-block property at this layer, then the handler runs asynchronously.
		expect(() =>
			emitter.emitAction('confined-binding.action-fails', { collection: 'articles' }, EVENT_CONTEXT)
		).not.toThrow();

		for (let attempt = 0; attempt < 100 && invoke.mock.calls.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(invoke).toHaveBeenCalledTimes(1);

		const invocation = invoke.mock.calls[0]![0] as { activation: string; input: unknown };
		expect(invocation.activation).toBe('event-action');

		expect(invocation.input).toEqual({
			event: 'confined-binding.action-fails',
			meta: { event: 'confined-binding.action-fails', collection: 'articles' },
		});

		for (let attempt = 0; attempt < 100 && warn.mock.calls.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(warn).toHaveBeenCalledWith(
			'The confined hook "failing-action-hook" failed for action "confined-binding.action-fails"'
		);

		warn.mockRestore();
	});

	it('unload removes the confined handlers so a reload cannot double-fire', async () => {
		const instance = await loadedHookManager('reload-hook', 'reload-hook', { filter: ['confined-binding.reload'] });

		const before = await emitter.emitFilter('confined-binding.reload', { v: 1 }, {}, EVENT_CONTEXT);
		expect(before).toHaveProperty('echoed');

		await (instance as any).unload();
		current = undefined;

		const payload = { v: 1 };
		const after = await emitter.emitFilter('confined-binding.reload', payload, {}, EVENT_CONTEXT);
		expect(after).toBe(payload);
	});

	it('refuses a hook whose manifest declares a prototype-key event and never subscribes', async () => {
		const proto = Object.getPrototypeOf({});

		writeConfinedPackage('proto-hook', 'export default {};\n', 'proto-hook', { log: true }, 'hook', {
			filter: ['__proto__.create'],
		});

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [hookExtension('proto-hook', 'proto-hook', true)];
		await (instance as any).load();
		current = instance;

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'proto-hook');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('MANIFEST_INVALID');

		expect((instance as any).hookEvents.some((event: any) => event.name === '__proto__.create')).toBe(false);

		// The reserved segment never reached the emitter, so Object.prototype is clean.
		expect(Object.prototype.hasOwnProperty.call(proto, 'create')).toBe(false);
	});

	it('refuses to subscribe a reserved-segment event that reaches eligibility past the schema', () => {
		const instance = new ExtensionManager();

		(instance as any).confinedRuntime = {
			supervisor: { invoke: async () => ({ ok: true, value: { done: true } }) },
			config: {
				sandbox: {
					settingsValueBytes: 1,
					httpResponseBytes: 1,
					itemsReplyBytes: 1,
					templateOutputBytes: 1,
					maxArtifactBytes: 1,
				},
				runtime: {},
			},
		};

		const extension = hookExtension('guard-hook', 'guard-hook', true);

		(instance as any).confinedEligible.set(extension, {
			entrySource: 'var CairnHook = {};',
			capabilities: {},
			events: { action: ['constructor.create'] },
		});

		(instance as any).registerConfinedHooks();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'guard-hook');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('EVENT_INVALID');

		// No handler joined the unregister list, so nothing subscribed to the emitter.
		expect((instance as any).hookEvents).toHaveLength(0);
	});

	it('refuses to subscribe a reserved-namespace event that reaches eligibility past the schema', () => {
		const instance = new ExtensionManager();
		current = instance;

		(instance as any).confinedRuntime = {
			supervisor: { invoke: async () => ({ ok: true, value: { done: true } }) },
			config: {
				sandbox: {
					settingsValueBytes: 1,
					httpResponseBytes: 1,
					itemsReplyBytes: 1,
					templateOutputBytes: 1,
					maxArtifactBytes: 1,
				},
				runtime: {},
			},
		};

		const extension = hookExtension('ws-guard-hook', 'ws-guard-hook', true);

		(instance as any).confinedEligible.set(extension, {
			entrySource: 'var CairnHook = {};',
			capabilities: {},
			events: { filter: ['websocket.message'] },
		});

		(instance as any).registerConfinedHooks();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'ws-guard-hook');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.code).toBe('EVENT_INVALID');
		expect(row?.reason?.detail).toBe(RESERVED_EVENT_NAMESPACE_ERROR);
		expect((instance as any).hookEvents).toHaveLength(0);
	});

	it('refuses a bundle hook entry that subscribes to a reserved namespace past the schema', () => {
		const instance = new ExtensionManager();
		current = instance;

		(instance as any).confinedRuntime = {
			supervisor: { invoke: async () => ({ ok: true, value: { done: true } }) },
			config: {
				sandbox: {
					settingsValueBytes: 1,
					httpResponseBytes: 1,
					itemsReplyBytes: 1,
					templateOutputBytes: 1,
					maxArtifactBytes: 1,
				},
				runtime: {},
			},
		};

		const extension: Extension = {
			path: 'ws-guard-bundle',
			name: 'ws-guard-bundle',
			type: 'bundle',
			entrypoint: { app: 'app.js', api: 'api.js' },
			entries: [{ type: 'hook', name: 'ws-entry' }],
			local: true,
			runtime: 'confined-server',
		};

		(instance as any).confinedEligible.set(extension, {
			entrySource: 'var CairnBundle = {};',
			entryEvents: { 'hook:ws-entry': { filter: ['websocket.message'] } },
			entryCapabilities: { 'hook:ws-entry': {} },
		});

		(instance as any).registerConfinedBundles();

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'ws-guard-bundle');
		const hookEntry = row?.entries?.find((entry: any) => entry.name === 'ws-entry');
		expect(hookEntry?.status).toBe('failed');
		expect(hookEntry?.reason?.code).toBe('EVENT_INVALID');
		expect(hookEntry?.reason?.detail).toBe(RESERVED_EVENT_NAMESPACE_ERROR);
		expect((instance as any).hookEvents).toHaveLength(0);
	});

	it('refuses a hook whose manifest subscribes to the reserved websocket namespace and never subscribes', async () => {
		writeConfinedPackage('ws-hook', 'export default {};\n', 'ws-hook', { log: true }, 'hook', {
			filter: ['websocket.message'],
		});

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [hookExtension('ws-hook', 'ws-hook', true)];
		await (instance as any).load();
		current = instance;

		const row = (instance as any).getDiagnostics().find((entry: any) => entry.name === 'ws-hook');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.detail).toBe(RESERVED_EVENT_NAMESPACE_ERROR);

		expect((instance as any).hookEvents.some((event: any) => event.name === 'websocket.message')).toBe(false);
	});

	it('drops the old listener on reload and adds none when the reloaded manifest is reserved', async () => {
		const first = await loadedHookManager('ws-reload-hook', 'ws-reload-hook', { filter: ['confined-binding.reload'] });

		const fired = await emitter.emitFilter('confined-binding.reload', { v: 1 }, {}, EVENT_CONTEXT);
		expect(fired).toHaveProperty('echoed');

		await (first as any).unload();
		current = undefined;

		const second = await loadedHookManager('ws-reload-hook', 'ws-reload-hook', { filter: ['websocket.message'] });

		const oldPayload = { v: 2 };
		expect(await emitter.emitFilter('confined-binding.reload', oldPayload, {}, EVENT_CONTEXT)).toBe(oldPayload);

		const reservedPayload = { v: 3 };
		expect(await emitter.emitFilter('websocket.message', reservedPayload, {}, EVENT_CONTEXT)).toBe(reservedPayload);

		const row = (second as any).getDiagnostics().find((entry: any) => entry.name === 'ws-reload-hook');
		expect(row?.status).toBe('failed');
		expect(row?.reason?.detail).toBe(RESERVED_EVENT_NAMESPACE_ERROR);
	});

	it('fails both confined hooks that declare the same id', async () => {
		writeConfinedPackage('dup-hook-a', 'export default {};\n', 'dup-hook', undefined, 'hook', {
			action: ['server.start'],
		});

		writeConfinedPackage('dup-hook-b', 'export default {};\n', 'dup-hook', undefined, 'hook', {
			action: ['server.start'],
		});

		const instance = new ExtensionManager();

		(instance as any).getExtensions = async () => [
			hookExtension('dup-hook-a', 'dup-hook', true),
			hookExtension('dup-hook-b', 'dup-hook', true),
		];

		await (instance as any).load();
		current = instance;

		const failed = (instance as any)
			.getDiagnostics()
			.filter((entry: any) => entry.name === 'dup-hook' && entry.reason?.code === 'AMBIGUOUS_HOOK');

		expect(failed).toHaveLength(2);
	});
});

describe('the confined bundle binding', () => {
	const EVENT_CONTEXT = { database: {} as never, schema: null, accountability: null };
	let current: ExtensionManager | undefined;

	afterEach(async () => {
		if (current !== undefined) await (current as any).unload();
		current = undefined;
		confinedRuntime.resolve = undefined;
	});

	type BundleEntrySpec = {
		type: 'operation' | 'endpoint' | 'hook';
		name: string;
		capabilities?: Record<string, unknown>;
		events?: { filter?: string[]; action?: string[] };
		optionDelivery?: Record<string, { delivery: 'reference' }>;
	};

	function writeConfinedBundle(dir: string, name: string, entries: BundleEntrySpec[]): void {
		const full = path.join(root, dir);
		mkdirSync(path.join(full, 'src'), { recursive: true });

		const manifestEntries = entries.map((entry) => ({
			type: entry.type,
			name: entry.name,
			source:
				entry.type === 'operation'
					? { app: `src/${entry.name}-app.js`, api: `src/${entry.name}-api.js` }
					: `src/${entry.name}.js`,
			...(entry.capabilities && { capabilities: entry.capabilities }),
			...(entry.events && { events: entry.events }),
			...(entry.optionDelivery && { optionDelivery: entry.optionDelivery }),
		}));

		writeFileSync(
			path.join(full, 'package.json'),
			JSON.stringify({
				name,
				version: '1.0.0',
				'cairncms:extension': {
					type: 'bundle',
					path: { app: 'app.js', api: 'api.js' },
					entries: manifestEntries,
					runtime: 'confined-server',
					host: '^10.0.0',
				},
			})
		);

		for (const entry of entries) {
			if (entry.type === 'operation') {
				writeFileSync(path.join(full, 'src', `${entry.name}-app.js`), 'export default {};\n');
				writeFileSync(path.join(full, 'src', `${entry.name}-api.js`), 'export default {};\n');
			} else {
				writeFileSync(path.join(full, 'src', `${entry.name}.js`), 'export default {};\n');
			}
		}

		const members = entries.map((entry) => {
			const key = JSON.stringify(`${entry.type}:${entry.name}`);

			if (entry.type === 'hook') {
				const handlers = (names: string[] | undefined) =>
					(names ?? []).map((event) => `${JSON.stringify(event)}: () => undefined`).join(', ');

				return `${key}: { id: ${JSON.stringify(entry.name)}, filters: { ${handlers(
					entry.events?.filter
				)} }, actions: { ${handlers(entry.events?.action)} } }`;
			}

			return `${key}: { id: ${JSON.stringify(entry.name)}, handler: async () => ({ body: null }) }`;
		});

		writeFileSync(path.join(full, 'api.js'), `var CairnBundle = (() => ({ default: { ${members.join(', ')} } }))();\n`);
	}

	function confinedBundleExtension(dir: string, name: string, entries: BundleEntrySpec[]): Extension {
		return {
			path: path.join(root, dir),
			name,
			type: 'bundle',
			entrypoint: { app: 'app.js', api: 'api.js' },
			entries: entries.map((entry) => ({ type: entry.type, name: entry.name })),
			local: true,
			runtime: 'confined-server',
		};
	}

	function endpointApp(
		instance: ExtensionManager,
		accountability: unknown = { user: 'u-1', role: 'r-1', admin: false }
	) {
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

	function diagnosticFor(instance: ExtensionManager, name: string): any {
		return (instance as any).getDiagnostics().find((entry: any) => entry.name === name);
	}

	it('registers every server entry of a bundle from the one artifact, selecting each entry by its key', async () => {
		const seen: string[] = [];

		confinedRuntime.resolve = async () => ({
			ok: true,
			supervisor: {
				probeLoad: async () => ({ loadable: true }),
				invoke: async (invocation: { activation?: string; bundleEntryKey?: string; input: unknown }) => {
					seen.push(invocation.bundleEntryKey ?? 'none');

					if (invocation.activation === 'event-filter') {
						return { ok: true, value: { unchanged: false, payload: { stamped: invocation.bundleEntryKey } } };
					}

					return { ok: true, value: { status: 200, body: { key: invocation.bundleEntryKey } } };
				},
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
			posture: { mode: 'auto', applied: [], missing: [], coreSatisfied: true, decision: 'run', cgroupMechanic: null },
		});

		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'bep', capabilities: { endpoint: { access: 'authenticated' } } },
			{ type: 'hook', name: 'bhk', capabilities: { log: true }, events: { filter: ['confined-bundle.filter'] } },
			{ type: 'operation', name: 'bop', capabilities: { log: true } },
		];

		writeConfinedBundle('multi-bundle', 'multi-bundle', entries);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [confinedBundleExtension('multi-bundle', 'multi-bundle', entries)];
		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'multi-bundle');
		expect(row.status).toBe('loaded');
		expect(row.runtime).toBe('confined-server');

		expect(row.entries).toEqual([
			{ name: 'bep', type: 'endpoint', status: 'loaded', capabilities: { endpoint: { access: 'authenticated' } } },
			{ name: 'bhk', type: 'hook', status: 'loaded', capabilities: { log: true } },
			{ name: 'bop', type: 'operation', status: 'loaded', capabilities: { log: true } },
		]);

		// The endpoint entry serves, selected by its `endpoint:bep` key.
		const served = await supertest(endpointApp(instance)).get('/bep/ping');
		expect(served.status).toBe(200);
		expect(served.body.key).toBe('endpoint:bep');

		// The hook entry is subscribed, selected by its `hook:bhk` key.
		const filtered = await emitter.emitFilter('confined-bundle.filter', { v: 1 }, {}, EVENT_CONTEXT);
		expect(filtered).toEqual({ stamped: 'hook:bhk' });

		// The operation entry is registered under its own contribution id.
		expect(getFlowManager().hasConfinedOperation('bop')).toBe(true);

		expect(seen).toContain('endpoint:bep');
		expect(seen).toContain('hook:bhk');
	});

	it('removes every server entry surface of a confined bundle on unload', async () => {
		confinedRuntime.resolve = async () => ({
			ok: true,
			supervisor: {
				probeLoad: async () => ({ loadable: true }),
				invoke: async (invocation: { activation?: string; bundleEntryKey?: string }) => {
					if (invocation.activation === 'event-filter') {
						return { ok: true, value: { unchanged: false, payload: { stamped: invocation.bundleEntryKey } } };
					}

					return { ok: true, value: { status: 200, body: { key: invocation.bundleEntryKey } } };
				},
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
			posture: { mode: 'auto', applied: [], missing: [], coreSatisfied: true, decision: 'run', cgroupMechanic: null },
		});

		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'rbep', capabilities: { endpoint: { access: 'authenticated' } } },
			{ type: 'hook', name: 'rbhk', capabilities: { log: true }, events: { filter: ['confined-bundle.reload'] } },
			{ type: 'operation', name: 'rbop', capabilities: { log: true } },
		];

		writeConfinedBundle('reload-bundle', 'reload-bundle', entries);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [confinedBundleExtension('reload-bundle', 'reload-bundle', entries)];
		await (instance as any).load();
		current = instance;

		// Every entry's surface is live before unload.
		expect((await supertest(endpointApp(instance)).get('/rbep/ping')).status).toBe(200);

		expect(await emitter.emitFilter('confined-bundle.reload', { v: 1 }, {}, EVENT_CONTEXT)).toEqual({
			stamped: 'hook:rbhk',
		});

		expect(getFlowManager().hasConfinedOperation('rbop')).toBe(true);

		await (instance as any).unload();

		// No stale route, handler, or operation survives the unload.
		expect((await supertest(endpointApp(instance)).get('/rbep/ping')).status).toBe(404);

		const payload = { v: 2 };
		expect(await emitter.emitFilter('confined-bundle.reload', payload, {}, EVENT_CONTEXT)).toBe(payload);
		expect(getFlowManager().hasConfinedOperation('rbop')).toBe(false);
	});

	it('gives a bundle operation entry its own optionDelivery and bleeds none onto a sibling', async () => {
		const entries: BundleEntrySpec[] = [
			{
				type: 'operation',
				name: 'secret-op',
				capabilities: { log: true },
				optionDelivery: { apiKey: { delivery: 'reference' } },
			},
			{ type: 'operation', name: 'plain-op', capabilities: { log: true } },
		];

		writeConfinedBundle('optdelivery-bundle', 'optdelivery-bundle', entries);

		const instance = new ExtensionManager();

		(instance as any).getExtensions = async () => [
			confinedBundleExtension('optdelivery-bundle', 'optdelivery-bundle', entries),
		];

		await (instance as any).load();
		current = instance;

		expect(diagnosticFor(instance, 'optdelivery-bundle').status).toBe('loaded');

		// Through the real load() copy, the descriptor registered for each entry carries
		// only that entry's reference keys, so a sensitive declaration is delivered to the
		// declaring entry and never bleeds onto a sibling that declared none.
		const confinedOps = (getFlowManager() as any).confinedOperations as Map<string, { referenceKeys: string[] } | null>;

		expect(confinedOps.get('secret-op')?.referenceKeys).toEqual(['apiKey']);
		expect(confinedOps.get('plain-op')?.referenceKeys).toEqual([]);
	});

	it('fails one entry on a route collision while its sibling still registers', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'taken-route', capabilities: { endpoint: { access: 'public' } } },
			{ type: 'hook', name: 'live-hook', capabilities: { log: true }, events: { filter: ['confined-bundle.collide'] } },
		];

		writeConfinedBundle('collide-bundle', 'collide-bundle', entries);

		const instance = new ExtensionManager();

		(instance as any).getExtensions = async () => [
			confinedBundleExtension('collide-bundle', 'collide-bundle', entries),
		];

		// An inherited endpoint already owns the route the bundle's endpoint entry wants.
		const originalRegister = (instance as any).registerEndpoints.bind(instance);

		(instance as any).registerEndpoints = async () => {
			await originalRegister();
			(instance as any).registeredEndpointRoutes.add('taken-route');
		};

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'collide-bundle');
		expect(row.status).toBe('partial');

		const endpointEntry = row.entries.find((entry: any) => entry.name === 'taken-route');
		expect(endpointEntry.status).toBe('failed');
		expect(endpointEntry.reason.code).toBe('ROUTE_COLLISION');

		const hookEntry = row.entries.find((entry: any) => entry.name === 'live-hook');
		expect(hookEntry.status).toBe('loaded');

		// The sibling hook actually subscribed despite the endpoint collision: the
		// baseline child stub transforms the payload, so the result is not the input.
		const filtered = await emitter.emitFilter('confined-bundle.collide', { v: 1 }, {}, EVENT_CONTEXT);
		expect(filtered).toHaveProperty('echoed');
	});

	it('keeps a partial bundle diagnostic free of its package path and any file url', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'served', capabilities: { endpoint: { access: 'public' } } },
			{ type: 'endpoint', name: 'ungranted', capabilities: { log: true } },
		];

		writeConfinedBundle('redact-bundle', 'redact-bundle', entries);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [confinedBundleExtension('redact-bundle', 'redact-bundle', entries)];

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'redact-bundle');
		expect(row.status).toBe('partial');

		const ungranted = row.entries.find((entry: any) => entry.name === 'ungranted');
		expect(ungranted.status).toBe('failed');
		expect(ungranted.reason.code).toBe('CAPABILITY_MISSING');
		expect(typeof ungranted.reason.detail).toBe('string');

		const serialized = JSON.stringify((instance as any).getDiagnostics());
		expect(serialized).not.toContain(root);
		expect(serialized).not.toContain('file://');
	});

	it('surfaces each bundle entry declared capabilities, scoped to that entry and present even when it fails', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'granted-ep', capabilities: { endpoint: { access: 'public' }, log: true } },
			{ type: 'endpoint', name: 'ungranted-ep', capabilities: { log: true } },
		];

		writeConfinedBundle('cap-bundle', 'cap-bundle', entries);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [confinedBundleExtension('cap-bundle', 'cap-bundle', entries)];

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'cap-bundle');
		expect(row.status).toBe('partial');
		// A bundle carries capabilities per entry, never one merged row-level object.
		expect(row.capabilities).toBeUndefined();

		const granted = row.entries.find((entry: any) => entry.name === 'granted-ep');
		expect(granted.status).toBe('loaded');
		expect(granted.capabilities).toEqual({ endpoint: { access: 'public' }, log: true });

		// The grant stays on its own entry, and survives even though this entry failed to
		// register, because eligibility existed.
		const ungranted = row.entries.find((entry: any) => entry.name === 'ungranted-ep');
		expect(ungranted.status).toBe('failed');
		expect(ungranted.reason.code).toBe('CAPABILITY_MISSING');
		expect(ungranted.capabilities).toEqual({ log: true });
	});

	it('fails both contributors of a duplicate operation id while the endpoint sibling mounts', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'operation', name: 'dup-op', capabilities: { log: true } },
			{ type: 'endpoint', name: 'mounted-ep', capabilities: { endpoint: { access: 'public' } } },
		];

		writeConfinedBundle('op-dup-bundle', 'op-dup-bundle', entries);

		// A top-level confined operation declares the same id the bundle op entry wants.
		// The id is resolved blocked across both contributors before either registers, so
		// neither is recorded loaded and then turned ambiguous by the other.
		writeConfinedOperationPackage('dup-top', 'dup-op');

		const instance = new ExtensionManager();

		(instance as any).getExtensions = async () => [
			operationExtension('dup-top', 'dup-op', true),
			confinedBundleExtension('op-dup-bundle', 'op-dup-bundle', entries),
		];

		await (instance as any).load();
		current = instance;

		// The top-level operation row is failed, not a stale loaded.
		const topRow = diagnosticFor(instance, 'dup-op');
		expect(topRow.status).toBe('failed');
		expect(topRow.reason.code).toBe('AMBIGUOUS_OPERATION');

		const row = diagnosticFor(instance, 'op-dup-bundle');
		expect(row.status).toBe('partial');

		const opEntry = row.entries.find((entry: any) => entry.name === 'dup-op');
		expect(opEntry.status).toBe('failed');
		expect(opEntry.reason.code).toBe('AMBIGUOUS_OPERATION');

		const epEntry = row.entries.find((entry: any) => entry.name === 'mounted-ep');
		expect(epEntry.status).toBe('loaded');

		const served = await supertest(endpointApp(instance)).get('/mounted-ep/x');
		expect(served.status).toBe(200);
	}, 30_000);

	it('fails a confined operation that collides with an inherited operation id', async () => {
		writeConfinedOperationPackage('inherited-clash', 'shared-op');

		// An inherited operation already owns the id, so the confined contributor is a
		// collision the precompute blocks before it registers a descriptor.
		getFlowManager().addOperation('shared-op', (() => ({ ok: true })) as any);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [operationExtension('inherited-clash', 'shared-op', true)];

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'shared-op');
		expect(row.status).toBe('failed');
		expect(row.reason.code).toBe('OPERATION_COLLISION');

		// A flow referencing the id rejects rather than silently running the inherited
		// operation that the confined contributor tried to shadow.
		const flow = {
			id: 'f',
			name: 'f',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: { id: 'op-x', key: 'step', type: 'shared-op', options: {}, resolve: null, reject: null },
		};

		const result = await (getFlowManager() as any).executeFlow(
			flow,
			{ x: 1 },
			{
				accountability: null,
				database: {},
				schema: { collections: {}, relations: [] },
			}
		);

		expect(result).toMatchObject({ message: expect.stringContaining('could not be resolved') });

		getFlowManager().clearOperations();
	}, 30_000);

	it('fails a top-level confined operation that collides with an inherited bundle operation', async () => {
		writeConfinedOperationPackage('bundle-clash-top', 'bundle-op');

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [operationExtension('bundle-clash-top', 'bundle-op', true)];

		// An inherited bundle contributes the id during registerBundles, after the
		// inherited top-level operations and before the confined lane, so the confined
		// precompute only sees it because it now runs after registerBundles.
		const originalRegister = (instance as any).registerBundles.bind(instance);

		(instance as any).registerBundles = async () => {
			await originalRegister();
			getFlowManager().addOperation('bundle-op', (() => ({ ok: true })) as any);
		};

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'bundle-op');
		expect(row.status).toBe('failed');
		expect(row.reason.code).toBe('OPERATION_COLLISION');

		getFlowManager().clearOperations();
	}, 30_000);

	it('fails a confined bundle operation entry that collides with an inherited bundle operation', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'operation', name: 'bundle-op', capabilities: { log: true } },
			{ type: 'endpoint', name: 'sibling-ep', capabilities: { endpoint: { access: 'public' } } },
		];

		writeConfinedBundle('entry-clash-bundle', 'entry-clash-bundle', entries);

		const instance = new ExtensionManager();

		(instance as any).getExtensions = async () => [
			confinedBundleExtension('entry-clash-bundle', 'entry-clash-bundle', entries),
		];

		// The same inherited bundle operation registered during registerBundles, so the
		// confined bundle op entry is a collision the precompute blocks before it mounts.
		const originalRegister = (instance as any).registerBundles.bind(instance);

		(instance as any).registerBundles = async () => {
			await originalRegister();
			getFlowManager().addOperation('bundle-op', (() => ({ ok: true })) as any);
		};

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'entry-clash-bundle');
		expect(row.status).toBe('partial');

		const opEntry = row.entries.find((entry: any) => entry.name === 'bundle-op');
		expect(opEntry.status).toBe('failed');
		expect(opEntry.reason.code).toBe('OPERATION_COLLISION');

		// The sibling endpoint still mounts, so the collision fails only its own entry.
		const epEntry = row.entries.find((entry: any) => entry.name === 'sibling-ep');
		expect(epEntry.status).toBe('loaded');

		getFlowManager().clearOperations();
	}, 30_000);

	it('fails the whole bundle with no per-entry loaded statuses when the shared artifact does not probe', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'ep', capabilities: { endpoint: { access: 'public' } } },
			{ type: 'hook', name: 'hk', capabilities: { log: true }, events: { action: ['items.create'] } },
		];

		writeConfinedBundle('bad-bundle', 'bad-bundle', entries);

		const extension = confinedBundleExtension('bad-bundle', 'bad-bundle', entries);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [extension];

		(instance as any).confinedGateDeps = {
			probe: async () => ({
				loadable: false,
				error: { code: 'invalid-entry', message: 'the bundle artifact is missing an entry' },
			}),
		};

		await (instance as any).load();
		current = instance;

		const row = diagnosticFor(instance, 'bad-bundle');
		expect(row.status).toBe('failed');

		// The whole server side failed at the gate, so no entry carries a loaded status.
		for (const entry of row.entries ?? []) {
			expect(entry.status).not.toBe('loaded');
		}

		// The same extension object the loader saw, so the absence is real and not an
		// identity miss against a throwaway clone.
		expect((instance as any).confinedEligible.has(extension)).toBe(false);
	});

	it('deep-copies per-entry reasons out of the diagnostics inventory', async () => {
		const entries: BundleEntrySpec[] = [
			{ type: 'endpoint', name: 'copy-route', capabilities: { endpoint: { access: 'public' } } },
			{ type: 'hook', name: 'copy-hook', capabilities: { log: true }, events: { action: ['items.create'] } },
		];

		writeConfinedBundle('copy-bundle', 'copy-bundle', entries);

		const instance = new ExtensionManager();
		(instance as any).getExtensions = async () => [confinedBundleExtension('copy-bundle', 'copy-bundle', entries)];

		const originalRegister = (instance as any).registerEndpoints.bind(instance);

		(instance as any).registerEndpoints = async () => {
			await originalRegister();
			(instance as any).registeredEndpointRoutes.add('copy-route');
		};

		await (instance as any).load();
		current = instance;

		const first = diagnosticFor(instance, 'copy-bundle').entries.find((entry: any) => entry.name === 'copy-route');
		first.reason.code = 'mutated';

		const second = diagnosticFor(instance, 'copy-bundle').entries.find((entry: any) => entry.name === 'copy-route');
		expect(second.reason.code).toBe('ROUTE_COLLISION');
	});
});
