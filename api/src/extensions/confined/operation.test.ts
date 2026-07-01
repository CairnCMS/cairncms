import axios from 'axios';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	runConfinedOperation,
	toConfinedAccountability,
	type ConfinedOperationDeps,
	type ConfinedOperationRequest,
} from './operation.js';
import {
	HTTP_RESPONSE_BYTES,
	ITEMS_REPLY_BYTES,
	SETTINGS_VALUE_BYTES,
	TEMPLATE_OUTPUT_BYTES,
} from './sandbox-limits.js';
import { EMPTY_SETTINGS_ACCESS } from './settings-access.js';
import type { ConfinedHostCallContext, ConfinedInvocation, ConfinedResult } from './types.js';

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

function request(overrides: Partial<ConfinedOperationRequest> = {}): ConfinedOperationRequest {
	return {
		extensionId: 'ext-1',
		contributionId: 'my-operation',
		operationId: 'op-row-1',
		entrySource: 'var CairnOperation = { default: { id: "my-operation", handler: () => ({}) } };',
		capabilities: {},
		options: {},
		input: null,
		accountability: null,
		...overrides,
	};
}

function deps(overrides: Partial<ConfinedOperationDeps> = {}): ConfinedOperationDeps {
	return {
		invoke: async () => ({ ok: true, value: null }),
		log: () => undefined,
		brokerLimits: BROKER_LIMITS,
		runtimeLimits: RUNTIME_LIMITS,
		settingsAccess: () => EMPTY_SETTINGS_ACCESS,
		...overrides,
	};
}

describe('runConfinedOperation', () => {
	it('runs the gate-probed entry with handle-substituted options and the $last input', async () => {
		let seen: ConfinedInvocation | undefined;

		const result = await runConfinedOperation(
			request({
				optionDelivery: { apiKey: { delivery: 'reference' } },
				options: { channel: 'general', apiKey: 'sk_live_secret' },
				input: { prior: 'output' },
			}),
			deps({
				invoke: async (invocation) => {
					seen = invocation;
					return { ok: true, value: { done: true } };
				},
			})
		);

		expect(result.outcome).toEqual({ ok: true, value: { done: true } });
		expect(seen?.entrySource).toContain('CairnOperation');
		expect(seen?.input).toEqual({ prior: 'output' });
		expect(seen?.options['channel']).toBe('general');
		expect(seen?.options['apiKey']).toMatchObject({ kind: 'secret-reference' });
		expect(JSON.stringify(seen)).not.toContain('sk_live_secret');
	});

	it('reduces the accountability to the guest-visible shape', async () => {
		let seen: ConfinedInvocation | undefined;

		await runConfinedOperation(
			request({ accountability: { user: 'u-1', role: 'r-1', admin: false, ip: '10.0.0.1' } as never }),
			deps({
				invoke: async (invocation) => {
					seen = invocation;
					return { ok: true, value: null };
				},
			})
		);

		expect(seen?.accountability).toEqual({ user: 'u-1', role: 'r-1', admin: false });
	});

	it('maps a guest failure to a sanitized reject outcome', async () => {
		const result = await runConfinedOperation(
			request(),
			deps({ invoke: async () => ({ ok: false, error: { code: 'guest-error', message: 'the operation failed' } }) })
		);

		expect(result.outcome).toEqual({ ok: false, error: { code: 'guest-error', message: 'the operation failed' } });
	});

	it('fails closed naming the misconfigured option key without its value', async () => {
		let invoked = false;

		const result = await runConfinedOperation(
			request({ optionDelivery: { apiKey: { delivery: 'reference' } }, options: { apiKey: 999 } }),
			deps({
				invoke: async () => {
					invoked = true;
					return { ok: true, value: null };
				},
			})
		);

		expect(invoked).toBe(false);
		expect(result.outcome).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

		if (!result.outcome.ok) {
			expect(result.outcome.error.message).toContain('apiKey');
			expect(result.outcome.error.message).not.toContain('999');
		}
	});

	it('returns a sanitized internal outcome rather than throwing when the supervisor throws', async () => {
		const result = await runConfinedOperation(
			request(),
			deps({
				invoke: async () => {
					throw new Error('the child crashed at /home/alison/secret');
				},
			})
		);

		expect(result.outcome).toEqual({
			ok: false,
			error: { code: 'internal', message: 'the confined operation failed' },
		});

		if (!result.outcome.ok) expect(result.outcome.error.message).not.toContain('/home/alison');
	});

	it('redacts both the minted handle and the clear configured reference value', async () => {
		let handleRef: string | undefined;

		const result = await runConfinedOperation(
			request({ optionDelivery: { apiKey: { delivery: 'reference' } }, options: { apiKey: 'sk_live_secret' } }),
			deps({
				invoke: async (invocation) => {
					handleRef = (invocation.options['apiKey'] as { ref: string }).ref;
					return { ok: true, value: null };
				},
			})
		);

		expect(result.redactionValues).toContain('sk_live_secret');
		expect(result.redactionValues).toContain(handleRef);
	});

	it('still redacts the configured reference value when the supervisor throws after preparation', async () => {
		const result = await runConfinedOperation(
			request({ optionDelivery: { apiKey: { delivery: 'reference' } }, options: { apiKey: 'sk_live_secret' } }),
			deps({
				invoke: async () => {
					throw new Error('the child crashed');
				},
			})
		);

		expect(result.outcome).toMatchObject({ ok: false, error: { code: 'internal' } });
		expect(result.redactionValues).toContain('sk_live_secret');
	});

	it('redacts an already-prepared sibling reference value when a later option fails preparation', async () => {
		const result = await runConfinedOperation(
			request({
				optionDelivery: { apiKey: { delivery: 'reference' }, webhookSecret: { delivery: 'reference' } },
				options: { apiKey: 'sk_live_first', webhookSecret: 4242 },
			}),
			deps()
		);

		expect(result.outcome).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		expect(result.redactionValues).toContain('sk_live_first');
	});
});

describe('runConfinedOperation brokered option secret', () => {
	let server: http.Server;
	let origin: string;
	const authSeen: Array<string | undefined> = [];

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			authSeen.push(req.headers['authorization']);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterAll(() => server.close());

	it('swaps a guest-held handle for the clear token at the request boundary', async () => {
		authSeen.length = 0;

		const context: ConfinedHostCallContext = {
			extensionId: 'ext-1',
			contributionId: 'my-operation',
			operationId: 'op-row-1',
		};

		// The stub supervisor drives the broker the way the real guest would: it reads
		// the apiKey handle from the options and sends a request authorized by it.
		const invoke = async (
			invocation: ConfinedInvocation,
			dispatcher: (
				call: { method: string; args: unknown },
				context: ConfinedHostCallContext,
				signal: AbortSignal
			) => Promise<unknown>
		): Promise<ConfinedResult> => {
			const handle = invocation.options['apiKey'];

			const reply = await dispatcher(
				{ method: 'request.send', args: { url: `${origin}/charge`, method: 'GET', auth: { bearer: handle } } },
				context,
				new AbortController().signal
			);

			return { ok: true, value: reply };
		};

		const result = await runConfinedOperation(
			request({
				capabilities: { request: { urls: [origin] } },
				optionDelivery: { apiKey: { delivery: 'reference' } },
				options: { apiKey: 'sk_live_real_token' },
			}),
			deps({ invoke: invoke as never, getAxios: async () => axios.create() })
		);

		expect(result.outcome.ok).toBe(true);
		expect(authSeen).toEqual(['Bearer sk_live_real_token']);
		expect(result.redactionValues).toContain('sk_live_real_token');
	});

	it('denies a handle forged for a different operation', async () => {
		authSeen.length = 0;

		const context: ConfinedHostCallContext = {
			extensionId: 'ext-1',
			contributionId: 'my-operation',
			operationId: 'op-row-1',
		};

		const invoke = async (
			invocation: ConfinedInvocation,
			dispatcher: (
				call: { method: string; args: unknown },
				context: ConfinedHostCallContext,
				signal: AbortSignal
			) => Promise<unknown>
		): Promise<ConfinedResult> => {
			// A handle minted for a different operation row must not resolve here.
			const forged = { kind: 'secret-reference', ref: 'forged-token' };

			const reply = await dispatcher(
				{ method: 'request.send', args: { url: `${origin}/charge`, method: 'GET', auth: { bearer: forged } } },
				context,
				new AbortController().signal
			);

			return { ok: true, value: reply };
		};

		const result = await runConfinedOperation(
			request({
				capabilities: { request: { urls: [origin] } },
				optionDelivery: { apiKey: { delivery: 'reference' } },
				options: { apiKey: 'sk_live_real_token' },
			}),
			deps({ invoke: invoke as never, getAxios: async () => axios.create() })
		);

		expect(result.outcome.ok).toBe(true);
		const reply = (result.outcome as { value: { ok: boolean } }).value;
		expect(reply.ok).toBe(false);
		expect(authSeen).toHaveLength(0);
	});
});

describe('toConfinedAccountability', () => {
	it('strips app so the guest accountability carries only user, role, and admin', () => {
		const result = toConfinedAccountability({ user: 'u-1', role: 'r-1', admin: true, app: true } as never);
		expect(result).toEqual({ user: 'u-1', role: 'r-1', admin: true });
		expect(result).not.toHaveProperty('app');
	});

	it('maps a null accountability to null', () => {
		expect(toConfinedAccountability(null)).toBe(null);
	});
});
