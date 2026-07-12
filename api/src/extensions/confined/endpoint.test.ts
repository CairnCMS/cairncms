import { describe, expect, it } from 'vitest';
import {
	ENDPOINT_BODY_BYTES_MAX,
	ENDPOINT_PATH_MAX,
	ENDPOINT_QUERY_KEYS_MAX,
	runConfinedEndpoint,
	type ConfinedEndpointDeps,
	type ConfinedEndpointRequest,
} from './endpoint.js';
import {
	HTTP_RESPONSE_BYTES,
	ITEMS_REPLY_BYTES,
	SETTINGS_VALUE_BYTES,
	TEMPLATE_OUTPUT_BYTES,
} from './sandbox-limits.js';
import { EMPTY_SETTINGS_ACCESS } from './settings-access.js';
import type { ConfinedInvocation } from './types.js';

const RUNTIME_LIMITS = {
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

function request(overrides: Partial<ConfinedEndpointRequest> = {}): ConfinedEndpointRequest {
	return {
		extensionId: 'ext-1',
		contributionId: 'my-endpoint',
		entrySource: 'var CairnEndpoint = { default: { id: "my-endpoint", handler: () => ({ body: null }) } };',
		capabilities: { endpoint: { access: 'public' } },
		method: 'GET',
		path: '/',
		query: {},
		body: undefined,
		accountability: null,
		...overrides,
	};
}

function deps(overrides: Partial<ConfinedEndpointDeps> = {}): ConfinedEndpointDeps {
	return {
		invoke: async () => ({ ok: true, value: { body: null } }),
		log: () => undefined,
		brokerLimits: BROKER_LIMITS,
		runtimeLimits: RUNTIME_LIMITS,
		settingsAccess: () => EMPTY_SETTINGS_ACCESS,
		...overrides,
	};
}

describe('runConfinedEndpoint', () => {
	it('hands the child the shaped request under the json-endpoint activation', async () => {
		let seen: ConfinedInvocation | undefined;

		const result = await runConfinedEndpoint(
			request({
				method: 'post',
				path: '/charge',
				query: { dry: 'true' },
				body: { amount: 12 },
				accountability: { user: 'u-1', role: 'r-1', admin: false, ip: '10.0.0.1' } as never,
			}),
			deps({
				invoke: async (invocation) => {
					seen = invocation;
					return { ok: true, value: { status: 201, body: { charged: true } } };
				},
			})
		);

		expect(result).toEqual({ ok: true, status: 201, body: { charged: true } });
		expect(seen?.activation).toBe('json-endpoint');
		expect(seen?.input).toEqual({ method: 'POST', path: '/charge', query: { dry: 'true' }, body: { amount: 12 } });
		expect(seen?.accountability).toEqual({ user: 'u-1', role: 'r-1', admin: false });
		expect(seen?.operationId).toBe('my-endpoint');
	});

	it('defaults the status to 200 and the body to null', async () => {
		const result = await runConfinedEndpoint(request(), deps({ invoke: async () => ({ ok: true, value: {} }) }));
		expect(result).toEqual({ ok: true, status: 200, body: null });
	});

	it('refuses a status outside 100 to 599 or a non-integer status', async () => {
		for (const status of [99, 600, 1.5, '200', null]) {
			const result = await runConfinedEndpoint(
				request(),
				deps({ invoke: async () => ({ ok: true, value: { status, body: null } }) })
			);

			expect(result, String(status)).toEqual({ ok: false, failure: 'internal' });
		}
	});

	it('refuses a result carrying anything beyond status and body', async () => {
		for (const extra of [
			{ status: 200, body: null, headers: { 'set-cookie': 'sid=1' } },
			{ body: null, redirect: '/elsewhere' },
			{ body: null, cookies: {} },
		]) {
			const result = await runConfinedEndpoint(request(), deps({ invoke: async () => ({ ok: true, value: extra }) }));
			expect(result).toEqual({ ok: false, failure: 'internal' });
		}
	});

	it('refuses a non-object result', async () => {
		for (const value of ['ok', 42, [1, 2], null]) {
			const result = await runConfinedEndpoint(request(), deps({ invoke: async () => ({ ok: true, value }) }));
			expect(result).toEqual({ ok: false, failure: 'internal' });
		}
	});

	it('drops the body for a HEAD request', async () => {
		const result = await runConfinedEndpoint(
			request({ method: 'HEAD' }),
			deps({ invoke: async () => ({ ok: true, value: { status: 200, body: { full: 'payload' } } }) })
		);

		expect(result).toEqual({ ok: true, status: 200, body: null });
	});

	it('denies before the child when the endpoint capability is not declared', async () => {
		let invoked = false;

		const result = await runConfinedEndpoint(
			request({ capabilities: {} }),
			deps({
				invoke: async () => {
					invoked = true;
					return { ok: true, value: { body: null } };
				},
			})
		);

		expect(result).toEqual({ ok: false, failure: 'denied' });
		expect(invoked).toBe(false);
	});

	it('requires a user before the child under authenticated access', async () => {
		let invoked = false;

		const dependencies = deps({
			invoke: async () => {
				invoked = true;
				return { ok: true, value: { body: null } };
			},
		});

		const capabilities = { endpoint: { access: 'authenticated' as const } };

		const anonymous = await runConfinedEndpoint(request({ capabilities }), dependencies);
		expect(anonymous).toEqual({ ok: false, failure: 'unauthenticated' });

		const publicCaller = await runConfinedEndpoint(
			request({ capabilities, accountability: { user: null, role: null, admin: false } as never }),
			dependencies
		);

		expect(publicCaller).toEqual({ ok: false, failure: 'unauthenticated' });
		expect(invoked).toBe(false);

		const authenticated = await runConfinedEndpoint(
			request({ capabilities, accountability: { user: 'u-1', role: 'r-1', admin: false } as never }),
			dependencies
		);

		expect(authenticated).toEqual({ ok: true, status: 200, body: null });
	});

	it('requires a user then the app flag before the child under app access', async () => {
		let invoked = false;

		const dependencies = deps({
			invoke: async () => {
				invoked = true;
				return { ok: true, value: { body: null } };
			},
		});

		const capabilities = { endpoint: { access: 'app' as const } };

		const anonymous = await runConfinedEndpoint(request({ capabilities }), dependencies);
		expect(anonymous).toEqual({ ok: false, failure: 'unauthenticated' });

		const nonApp = await runConfinedEndpoint(
			request({ capabilities, accountability: { user: 'u-1', role: 'r-1', admin: false } as never }),
			dependencies
		);

		expect(nonApp).toEqual({ ok: false, failure: 'denied' });
		expect(invoked).toBe(false);

		const appCaller = await runConfinedEndpoint(
			request({ capabilities, accountability: { user: 'u-1', role: 'r-1', admin: false, app: true } as never }),
			dependencies
		);

		expect(appCaller).toEqual({ ok: true, status: 200, body: null });
	});

	it('requires a user then the admin flag before the child under admin access', async () => {
		let invoked = false;

		const dependencies = deps({
			invoke: async () => {
				invoked = true;
				return { ok: true, value: { body: null } };
			},
		});

		const capabilities = { endpoint: { access: 'admin' as const } };

		const anonymous = await runConfinedEndpoint(request({ capabilities }), dependencies);
		expect(anonymous).toEqual({ ok: false, failure: 'unauthenticated' });

		const nonAdmin = await runConfinedEndpoint(
			request({ capabilities, accountability: { user: 'u-1', role: 'r-1', admin: false } as never }),
			dependencies
		);

		expect(nonAdmin).toEqual({ ok: false, failure: 'denied' });
		expect(invoked).toBe(false);

		const adminCaller = await runConfinedEndpoint(
			request({ capabilities, accountability: { user: 'u-1', role: 'r-1', admin: true } as never }),
			dependencies
		);

		expect(adminCaller).toEqual({ ok: true, status: 200, body: null });
	});

	it('refuses an unsupported method', async () => {
		const result = await runConfinedEndpoint(request({ method: 'TRACE' }), deps());
		expect(result).toEqual({ ok: false, failure: 'invalid-request' });
	});

	it('refuses an unshapeable query', async () => {
		for (const query of [{ tags: ['a', 'b'] }, { nested: { deep: 'x' } }, 'flat']) {
			const result = await runConfinedEndpoint(request({ query }), deps());
			expect(result).toEqual({ ok: false, failure: 'invalid-request' });
		}
	});

	it('bounds the query key count', async () => {
		const query = Object.fromEntries(Array.from({ length: ENDPOINT_QUERY_KEYS_MAX + 1 }, (_, i) => [`k${i}`, 'v']));
		const result = await runConfinedEndpoint(request({ query }), deps());
		expect(result).toEqual({ ok: false, failure: 'invalid-request' });
	});

	it('keeps a __proto__ query key an ordinary own property', async () => {
		let seen: ConfinedInvocation | undefined;

		const result = await runConfinedEndpoint(
			request({ query: JSON.parse('{"__proto__":"x"}') }),
			deps({
				invoke: async (invocation) => {
					seen = invocation;
					return { ok: true, value: { body: null } };
				},
			})
		);

		expect(result.ok).toBe(true);
		const query = (seen?.input as { query: Record<string, string> }).query;
		expect(Object.prototype.hasOwnProperty.call(query, '__proto__')).toBe(true);
	});

	it('refuses an oversized body before the child', async () => {
		let invoked = false;

		const result = await runConfinedEndpoint(
			request({ body: { blob: 'x'.repeat(ENDPOINT_BODY_BYTES_MAX) } }),
			deps({
				invoke: async () => {
					invoked = true;
					return { ok: true, value: { body: null } };
				},
			})
		);

		expect(result).toEqual({ ok: false, failure: 'invalid-request' });
		expect(invoked).toBe(false);
	});

	it('refuses an oversized or relative path', async () => {
		const long = await runConfinedEndpoint(request({ path: `/${'x'.repeat(ENDPOINT_PATH_MAX)}` }), deps());
		expect(long).toEqual({ ok: false, failure: 'invalid-request' });

		const relative = await runConfinedEndpoint(request({ path: 'no-slash' }), deps());
		expect(relative).toEqual({ ok: false, failure: 'invalid-request' });
	});

	it('maps a guest failure and a thrown supervisor to a sanitized internal failure', async () => {
		const guestFailure = await runConfinedEndpoint(
			request(),
			deps({ invoke: async () => ({ ok: false, error: { code: 'guest-error', message: 'the json endpoint failed' } }) })
		);

		expect(guestFailure).toEqual({ ok: false, failure: 'internal' });

		const thrown = await runConfinedEndpoint(
			request(),
			deps({
				invoke: async () => {
					throw new Error('the child crashed at /home/alison/secret');
				},
			})
		);

		expect(thrown).toEqual({ ok: false, failure: 'internal' });
	});
});
