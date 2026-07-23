import axios from 'axios';
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import {
	HTTP_RESPONSE_BYTES,
	ITEMS_REPLY_BYTES,
	SETTINGS_VALUE_BYTES,
	TEMPLATE_OUTPUT_BYTES,
} from './sandbox-limits.js';
import { runConfinedEndpoint } from './endpoint.js';
import { runConfinedActionHook, runConfinedFilterHook } from './hook.js';
import { runConfinedOperation } from './operation.js';
import { buildConfinedSettingsAccess, EMPTY_SETTINGS_ACCESS } from './settings-access.js';
import { ConfinedSupervisor } from './supervisor.js';
import type { ConfinedHostDispatcher, ConfinedInvocation, ConfinedResult, ConfinedRuntimeLimits } from './types.js';

// The full stack with nothing stubbed between the guest and the host: a real spawned
// QuickJS child driven by the real supervisor, brokered by the real
// createConfinedHostBroker the runners build internally. The dev tsx child path needs
// no build, the same path supervisor.test.ts exercises by default.
const ENGINE_TIMEOUT = 20_000;

const LIMITS: ConfinedRuntimeLimits = {
	wallClockMs: 5000,
	cpuTimeoutMs: 2000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	acquireTimeoutMs: 0,
	hostCallTimeoutMs: 5000,
	maxHostCalls: 1000,
	maxInFlightHostCalls: 16,
};

const BROKER_LIMITS = {
	settingsValueBytes: SETTINGS_VALUE_BYTES,
	httpResponseBytes: HTTP_RESPONSE_BYTES,
	itemsReplyBytes: ITEMS_REPLY_BYTES,
	templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
};

const supervisor = new ConfinedSupervisor();

const invoke = (invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher): Promise<ConfinedResult> =>
	supervisor.invoke(invocation, dispatcher);

let logs: { level: string; message: string }[] = [];
const log = (entry: { level: string; message: string }) => logs.push(entry);

beforeEach(() => {
	logs = [];
});

function operationEntry(handlerBody: string): string {
	return `var CairnOperation = (() => { const handler = ${handlerBody}; return { default: { id: 'e2e-op', handler } }; })();`;
}

function endpointEntry(handlerBody: string): string {
	return `var CairnEndpoint = (() => { const handler = ${handlerBody}; return { default: { id: 'e2e-ep', handler } }; })();`;
}

function hookEntry(kind: 'filters' | 'actions', event: string, handlerBody: string): string {
	return `var CairnHook = (() => { const handler = ${handlerBody}; return { default: { id: 'e2e-hook', ${kind}: { ${JSON.stringify(
		event
	)}: handler } } }; })();`;
}

function baseOperationRequest(entrySource: string, overrides: Record<string, unknown> = {}) {
	return {
		extensionId: 'local.e2e',
		contributionId: 'e2e-op',
		operationId: 'op-1',
		entrySource,
		capabilities: {},
		options: {},
		input: null,
		accountability: null,
		...overrides,
	};
}

const deps = {
	invoke,
	log,
	brokerLimits: BROKER_LIMITS,
	runtimeLimits: LIMITS,
	settingsAccess: () => EMPTY_SETTINGS_ACCESS,
};

describe('confined contracts through a real child', () => {
	it(
		'runs an operation, reading an option and returning a value',
		async () => {
			const result = await runConfinedOperation(
				baseOperationRequest(operationEntry('async ({ options }) => ({ doubled: options.n * 2 })'), {
					options: { n: 21 },
				}),
				deps
			);

			expect(result.outcome).toEqual({ ok: true, value: { doubled: 42 } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'runs a json endpoint, shaping the request and holding the result contract',
		async () => {
			const result = await runConfinedEndpoint(
				{
					extensionId: 'local.e2e',
					contributionId: 'e2e-ep',
					entrySource: endpointEntry(
						'async (request) => ({ status: 201, body: { method: request.method, path: request.path, query: request.query } })'
					),
					capabilities: { endpoint: { access: 'public' } },
					method: 'GET',
					path: '/widgets',
					query: { page: '2' },
					body: null,
					accountability: null,
				},
				deps
			);

			expect(result).toEqual({
				ok: true,
				status: 201,
				body: { method: 'GET', path: '/widgets', query: { page: '2' } },
			});
		},
		ENGINE_TIMEOUT
	);

	it(
		'runs a filter hook, carrying the changed payload through the envelope',
		async () => {
			const result = await runConfinedFilterHook(
				{
					extensionId: 'local.e2e',
					contributionId: 'e2e-hook',
					entrySource: hookEntry('filters', 'e2e.filter', 'async (payload) => ({ ...payload, stamped: true })'),
					capabilities: { log: true },
					event: 'e2e.filter',
					payload: { value: 1 },
					meta: {},
					accountability: null,
				},
				deps
			);

			expect(result).toEqual({ ok: true, unchanged: false, payload: { value: 1, stamped: true } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'runs an action hook, completing without blocking',
		async () => {
			const result = await runConfinedActionHook(
				{
					extensionId: 'local.e2e',
					contributionId: 'e2e-hook',
					entrySource: hookEntry('actions', 'e2e.action', 'async () => ({ done: true })'),
					capabilities: { log: true },
					event: 'e2e.action',
					meta: { collection: 'widgets' },
					accountability: null,
				},
				deps
			);

			expect(result).toEqual({ ok: true });
		},
		ENGINE_TIMEOUT
	);

	it(
		'selects one entry of a bundle artifact by its type:name key',
		async () => {
			const artifact = `var CairnBundle = (() => ({ default: { 'operation:bundled': { id: 'bundled', handler: async ({ options }) => ({ fromBundle: options.n }) }, 'operation:other': { id: 'other', handler: async () => ({ wrong: true }) } } }))();`;

			const result = await runConfinedOperation(
				baseOperationRequest(artifact, {
					contributionId: 'bundled',
					bundleEntryKey: 'operation:bundled',
					options: { n: 7 },
				}),
				deps
			);

			expect(result.outcome).toEqual({ ok: true, value: { fromBundle: 7 } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'executes the entry as bytes in the child and never imports it into the API process',
		async () => {
			// `global` is a Node global the QuickJS guest does not expose (it carries a
			// `process` shim, so process is not a discriminator here). The guard throws
			// under Node, so importing this entry into the API process would fail loudly. In
			// the child `global` is absent, so the same bytes produce a valid config and
			// run, proving the entry was executed as bytes, never imported.
			const canary = `if (typeof global !== 'undefined') { throw new Error('IMPORTED_UNDER_NODE'); }\n${operationEntry(
				'async () => ({ ran: true })'
			)}`;

			expect(() => new Function(`${canary}\nreturn CairnOperation;`)()).toThrow('IMPORTED_UNDER_NODE');

			const result = await runConfinedOperation(baseOperationRequest(canary), deps);
			expect(result.outcome).toEqual({ ok: true, value: { ran: true } });
		},
		ENGINE_TIMEOUT
	);
});

describe('host methods through a real child and the real broker', () => {
	it(
		'reaches the log sink under the log capability and never without it',
		async () => {
			const granted = await runConfinedOperation(
				baseOperationRequest(
					operationEntry(
						"async (_input, { host }) => { await host.log.info('hello from the guest'); return { ran: true }; }"
					),
					{ capabilities: { log: true } }
				),
				deps
			);

			expect(granted.outcome).toEqual({ ok: true, value: { ran: true } });
			expect(logs).toHaveLength(1);
			expect(logs[0]?.level).toBe('info');

			logs = [];

			// The guest log wrapper discards the host reply, so denial is observable only at
			// the sink: the operation still returns, but nothing was logged.
			const denied = await runConfinedOperation(
				baseOperationRequest(
					operationEntry(
						"async (_input, { host }) => { await host.log.info('hello from the guest'); return { ran: true }; }"
					),
					{ capabilities: {} }
				),
				deps
			);

			expect(denied.outcome).toEqual({ ok: true, value: { ran: true } });
			expect(logs).toHaveLength(0);
		},
		ENGINE_TIMEOUT
	);

	it(
		'an extension with no declared settings reads null for every key',
		async () => {
			// Settings are ownership-gated, not capability-gated: an extension that declares no
			// settings has the empty settings access (the no-owner shape), so every key reads null
			// rather than denying.
			const result = await runConfinedOperation(
				baseOperationRequest(operationEntry("async (_input, { host }) => host.settings.get('mode')"), {
					capabilities: {},
				}),
				deps
			);

			expect(result.outcome).toEqual({ ok: true, value: { ok: true, value: null } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'reads items through the wired service, with the deprecated read alias equal to readMany',
		async () => {
			const itemsService = () => ({
				readByQuery: async () => [{ id: 1, title: 'one' }],
				readOne: async (key: string | number) => ({ id: key }),
			});

			// read is the deprecated alias of readMany and must return the same result.
			// The broker accepts only items.readMany, so a passing read proves the alias
			// dispatches the canonical wire key, not a stale items.read.
			const granted = await runConfinedOperation(
				baseOperationRequest(
					operationEntry(
						"async (_input, { host }) => ({ readMany: await host.items.readMany('widgets', {}), read: await host.items.read('widgets', {}), readOne: await host.items.readOne('widgets', '1', {}) })"
					),
					{ capabilities: { items: { accountability: 'full-access' } } }
				),
				{ ...deps, itemsService }
			);

			expect(granted.outcome).toEqual({
				ok: true,
				value: {
					readMany: { ok: true, value: [{ id: 1, title: 'one' }] },
					read: { ok: true, value: [{ id: 1, title: 'one' }] },
					readOne: { ok: true, value: { id: '1' } },
				},
			});

			const denied = await runConfinedOperation(
				baseOperationRequest(operationEntry("async (_input, { host }) => host.items.readMany('widgets', {})"), {
					capabilities: {},
				}),
				{ ...deps, itemsService }
			);

			expect(denied.outcome).toMatchObject({ ok: true, value: { ok: false, error: { code: 'denied' } } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'renders a template under the template capability and denies without it',
		async () => {
			const granted = await runConfinedOperation(
				baseOperationRequest(
					operationEntry("async (_input, { host }) => host.template.renderLiquid('Hi {{ n }}', { n: 1 })"),
					{ capabilities: { template: true } }
				),
				deps
			);

			expect(granted.outcome).toEqual({ ok: true, value: { ok: true, value: 'Hi 1' } });

			const denied = await runConfinedOperation(
				baseOperationRequest(operationEntry("async (_input, { host }) => host.template.renderLiquid('Hi', {})"), {
					capabilities: {},
				}),
				deps
			);

			expect(denied.outcome).toMatchObject({ ok: true, value: { ok: false, error: { code: 'denied' } } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'denies request.send at the capability gate before any url or axios work',
		async () => {
			let axiosCalls = 0;

			const getAxios = async () => {
				axiosCalls++;
				return axios.create();
			};

			// A malformed url and a counting axios seam make the test discriminating: if the
			// capability gate did not run first, url validation would answer invalid_request
			// or the axios seam would be reached. The denied reply (not invalid_request) and
			// the untouched seam prove the missing-capability check runs before either.
			const denied = await runConfinedOperation(
				baseOperationRequest(
					operationEntry("async (_input, { host }) => host.request.send({ url: 'not-a-valid-url', method: 'GET' })"),
					{ capabilities: {} }
				),
				{ ...deps, getAxios }
			);

			expect(denied.outcome).toMatchObject({ ok: true, value: { ok: false, error: { code: 'denied' } } });
			expect(axiosCalls).toBe(0);
		},
		ENGINE_TIMEOUT
	);
});

describe('brokered request with a real secret through a real child', () => {
	let server: http.Server;
	let origin: string;
	const authSeen: Array<string | undefined> = [];

	beforeAll(async () => {
		server = http.createServer((request, response) => {
			authSeen.push(request.headers['authorization']);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ echoedAuth: request.headers['authorization'] ?? null }));
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterAll(() => {
		server.close();
	});

	it(
		'delivers the real token to the upstream as a bearer header while the guest only ever holds the opaque handle, scrubbed from the output',
		async () => {
			const secret = 'sk_live_E2E_SECRET_TOKEN';

			const result = await runConfinedOperation(
				baseOperationRequest(
					// The guest logs the opaque handle ref it holds, then makes the brokered
					// call. The configured secret reaches the guest only as { kind, ref }.
					operationEntry(
						"async ({ options }, { host }) => { await host.log.info('calling upstream with ' + options.apiKey.ref); return host.request.send({ url: options.url, method: 'GET', auth: { bearer: options.apiKey } }); }"
					),
					{
						capabilities: { request: { urls: [origin] }, log: true },
						options: { url: `${origin}/echo`, apiKey: secret },
						optionDelivery: { apiKey: { delivery: 'reference' } },
					}
				),
				{ ...deps, getAxios: async () => axios.create() }
			);

			// The real token reached the upstream as the broker-owned Authorization header.
			expect(authSeen).toContain(`Bearer ${secret}`);

			// The guest never saw the raw token: it is scrubbed from the response the guest
			// receives and is in the redaction set for revision and log scrubbing.
			expect(result.outcome).toMatchObject({ ok: true });
			expect(JSON.stringify(result.outcome)).not.toContain(secret);
			expect(result.redactionValues).toContain(secret);

			// The log sink scrub is real, not vacuous: the guest wrote a log carrying the
			// opaque handle, and the broker redacted it before the sink. The minted handle
			// is the redaction value that is not the secret, so assert the entry exists,
			// carries the marker, and leaks neither the raw secret nor the handle itself.
			const handle = result.redactionValues.find((value) => value !== secret);
			expect(handle).toBeDefined();

			const serializedLogs = JSON.stringify(logs);
			expect(logs).not.toHaveLength(0);
			expect(serializedLogs).toContain(REDACT_TEXT);
			expect(serializedLogs).not.toContain(secret);
			expect(serializedLogs).not.toContain(String(handle));
		},
		ENGINE_TIMEOUT
	);

	it(
		'delivers a confined bundle operation entry the same brokered secret as a handle, scrubbed from output and logs',
		async () => {
			const secret = 'sk_live_BUNDLE_SECRET_TOKEN';

			// One server entry of a CairnBundle, selected by its `operation:secret-op` key.
			// The entry holds the configured option only as the opaque handle, passes it as
			// brokered auth, and the resolved secret reaches the upstream but not the guest.
			const artifact =
				"var CairnBundle = (() => ({ default: { 'operation:secret-op': { id: 'secret-op', handler: async ({ options }, { host }) => { await host.log.info('calling upstream with ' + options.apiKey.ref); return host.request.send({ url: options.url, method: 'GET', auth: { bearer: options.apiKey } }); } } } }))();";

			const result = await runConfinedOperation(
				baseOperationRequest(artifact, {
					contributionId: 'secret-op',
					bundleEntryKey: 'operation:secret-op',
					capabilities: { request: { urls: [origin] }, log: true },
					options: { url: `${origin}/echo`, apiKey: secret },
					optionDelivery: { apiKey: { delivery: 'reference' } },
				}),
				{ ...deps, getAxios: async () => axios.create() }
			);

			// The brokered request succeeding is the delivery proof: a clear value would not
			// resolve as a handle, so the real token reaches the upstream only because the
			// entry received the opaque handle and passed it as auth.
			expect(authSeen).toContain(`Bearer ${secret}`);

			expect(result.outcome).toMatchObject({ ok: true });
			expect(JSON.stringify(result.outcome)).not.toContain(secret);
			expect(result.redactionValues).toContain(secret);

			const handle = result.redactionValues.find((value) => value !== secret);
			expect(handle).toBeDefined();

			const serializedLogs = JSON.stringify(logs);
			expect(logs).not.toHaveLength(0);
			expect(serializedLogs).toContain(REDACT_TEXT);
			expect(serializedLogs).not.toContain(secret);
			expect(serializedLogs).not.toContain(String(handle));
		},
		ENGINE_TIMEOUT
	);
});

describe('extension settings reads and brokered secret through a real child', () => {
	let server: http.Server;
	let origin: string;
	const authSeen: Array<string | undefined> = [];

	const SETTING_SECRET = 'sk_live_SETTINGS_SECRET_TOKEN';
	const BASE_URL = 'https://preview.example.com';

	const SETTINGS_SUBJECT = 'cairncms-extension-e2e';
	const API_KEY_VAR = 'CAIRNCMS_EXT_E2E_API_KEY';
	const UNSET_KEY_VAR = 'CAIRNCMS_EXT_E2E_UNSET_KEY';

	const SETTINGS_DECLARATION: any = {
		base_url: { type: 'string', scope: 'global' },
		api_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
		unset_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
	};

	const SETTINGS_ROWS = [{ key: 'base_url', value: BASE_URL }];

	// Subject-aware so a wrong subject yields an empty access. The bundle case passing
	// proves the bundle's own subject (local.e2e) reaches the settings read.
	const settingsAccess = (subject: string) =>
		buildConfinedSettingsAccess({
			subject: SETTINGS_SUBJECT,
			declaration: subject === 'local.e2e' ? SETTINGS_DECLARATION : undefined,
			readRows: async () => (subject === 'local.e2e' ? SETTINGS_ROWS : []),
		});

	const settingsDeps = { ...deps, settingsAccess, getAxios: async () => axios.create() };

	beforeAll(async () => {
		process.env[API_KEY_VAR] = SETTING_SECRET;
		delete process.env[UNSET_KEY_VAR];

		server = http.createServer((request, response) => {
			authSeen.push(request.headers['authorization']);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ok: true }));
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterAll(() => {
		server.close();
		delete process.env[API_KEY_VAR];
	});

	beforeEach(() => {
		authSeen.length = 0;
	});

	it(
		'operation reads a value and a handle, an unset secret and an undeclared key as null, and resolves the handle',
		async () => {
			const result = await runConfinedOperation(
				baseOperationRequest(
					operationEntry(
						`async (_input, { host }) => { const baseUrl = (await host.settings.get('base_url')).value; const apiKey = (await host.settings.get('api_key')).value; const unsetKey = (await host.settings.get('unset_key')).value; const undeclared = (await host.settings.get('nope')).value; await host.log.info('handle ' + apiKey.ref); await host.request.send({ url: '${origin}/echo', method: 'GET', auth: { bearer: apiKey } }); return { baseUrl, apiKeyKind: apiKey.kind, unsetKey, undeclared }; }`
					),
					{ capabilities: { request: { urls: [origin] }, log: true } }
				),
				settingsDeps
			);

			expect(result.outcome).toMatchObject({
				ok: true,
				value: { baseUrl: BASE_URL, apiKeyKind: 'secret-reference', unsetKey: null, undeclared: null },
			});

			expect(authSeen).toContain(`Bearer ${SETTING_SECRET}`);
			expect(JSON.stringify(result.outcome)).not.toContain(SETTING_SECRET);
			expect(result.redactionValues).toContain(SETTING_SECRET);

			const serializedLogs = JSON.stringify(logs);
			expect(serializedLogs).toContain(REDACT_TEXT);
			expect(serializedLogs).not.toContain(SETTING_SECRET);
		},
		ENGINE_TIMEOUT
	);

	it(
		'endpoint reads its settings and resolves the handle at brokered use',
		async () => {
			const result = await runConfinedEndpoint(
				{
					extensionId: 'local.e2e',
					contributionId: 'e2e-ep',
					entrySource: endpointEntry(
						`async (_request, { host }) => { const baseUrl = (await host.settings.get('base_url')).value; const apiKey = (await host.settings.get('api_key')).value; await host.request.send({ url: '${origin}/echo', method: 'GET', auth: { bearer: apiKey } }); return { status: 200, body: { baseUrl } }; }`
					),
					capabilities: { endpoint: { access: 'public' }, request: { urls: [origin] } },
					method: 'GET',
					path: '/run',
					query: {},
					body: null,
					accountability: null,
				},
				settingsDeps
			);

			expect(result).toMatchObject({ ok: true, status: 200, body: { baseUrl: BASE_URL } });
			expect(authSeen).toContain(`Bearer ${SETTING_SECRET}`);
			expect(JSON.stringify(result)).not.toContain(SETTING_SECRET);
		},
		ENGINE_TIMEOUT
	);

	it(
		'action hook reads its settings and resolves the handle at brokered use',
		async () => {
			const result = await runConfinedActionHook(
				{
					extensionId: 'local.e2e',
					contributionId: 'e2e-hook',
					entrySource: hookEntry(
						'actions',
						'e2e.settings',
						`async (_meta, { host }) => { const baseUrl = (await host.settings.get('base_url')).value; await host.log.info('base ' + baseUrl); const apiKey = (await host.settings.get('api_key')).value; await host.request.send({ url: '${origin}/echo', method: 'GET', auth: { bearer: apiKey } }); return { done: true }; }`
					),
					capabilities: { log: true, request: { urls: [origin] } },
					event: 'e2e.settings',
					meta: {},
					accountability: null,
				},
				settingsDeps
			);

			expect(result).toEqual({ ok: true });
			expect(authSeen).toContain(`Bearer ${SETTING_SECRET}`);
			expect(JSON.stringify(logs)).toContain(`base ${BASE_URL}`);
			expect(JSON.stringify(logs)).not.toContain(SETTING_SECRET);
		},
		ENGINE_TIMEOUT
	);

	it(
		'bundle operation entry reads settings under the bundle subject and resolves the handle',
		async () => {
			const artifact = `var CairnBundle = (() => ({ default: { 'operation:settings-op': { id: 'settings-op', handler: async (_input, { host }) => { const baseUrl = (await host.settings.get('base_url')).value; const apiKey = (await host.settings.get('api_key')).value; await host.request.send({ url: '${origin}/echo', method: 'GET', auth: { bearer: apiKey } }); return { baseUrl }; } } } }))();`;

			const result = await runConfinedOperation(
				baseOperationRequest(artifact, {
					contributionId: 'settings-op',
					bundleEntryKey: 'operation:settings-op',
					capabilities: { request: { urls: [origin] } },
				}),
				settingsDeps
			);

			expect(result.outcome).toMatchObject({ ok: true, value: { baseUrl: BASE_URL } });
			expect(authSeen).toContain(`Bearer ${SETTING_SECRET}`);
			expect(JSON.stringify(result.outcome)).not.toContain(SETTING_SECRET);
		},
		ENGINE_TIMEOUT
	);
});
