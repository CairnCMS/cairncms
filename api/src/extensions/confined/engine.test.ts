import { describe, expect, it } from 'vitest';
import { runConfinedEntry, unsupportedHostBridge } from './engine.js';
import type { ConfinedHostBridge, ConfinedInvocation, ConfinedRuntimeLimits } from './types.js';

function run(inv: ConfinedInvocation, bridge: ConfinedHostBridge = unsupportedHostBridge) {
	return runConfinedEntry(inv, bridge);
}

const LIMITS: ConfinedRuntimeLimits = {
	wallClockMs: 5000,
	cpuTimeoutMs: 1000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	acquireTimeoutMs: 0,
	hostCallTimeoutMs: 5000,
	maxHostCalls: 1000,
	maxInFlightHostCalls: 16,
};

function entry(handlerBody: string): string {
	return `var CairnOperation = (() => { const handler = ${handlerBody}; return { default: { id: 'flow-operation.test', handler } }; })();`;
}

function invocation(entrySource: string, overrides: Partial<ConfinedInvocation> = {}): ConfinedInvocation {
	return {
		extensionId: 'local.test',
		contributionId: 'flow-operation.test',
		operationId: 'op-1',
		entrySource,
		options: {},
		input: null,
		accountability: null,
		limits: LIMITS,
		...overrides,
	};
}

describe('runConfinedEntry', () => {
	it('runs a portable operation and returns a JSON-safe result', async () => {
		const result = await run(
			invocation(entry('async ({ options, input }) => ({ ok: true, amount: options.amount, echoed: input })'), {
				options: { amount: 1200 },
				input: { id: 'evt_1' },
			})
		);

		expect(result).toEqual({ ok: true, value: { ok: true, amount: 1200, echoed: { id: 'evt_1' } } });
	});

	it('cannot read a host secret from process.env', async () => {
		process.env['CONFINED_PROBE_SECRET'] = 'host-secret-must-not-leak';

		try {
			const result = await run(
				invocation(
					entry(
						'() => ({ secret: (typeof process !== "undefined" && process.env) ? (process.env.CONFINED_PROBE_SECRET ?? null) : null })'
					)
				)
			);

			expect(result.ok).toBe(true);
			if (result.ok) expect((result.value as Record<string, unknown>)['secret']).toBeNull();
		} finally {
			delete process.env['CONFINED_PROBE_SECRET'];
		}
	});

	it('has no require', async () => {
		const result = await run(invocation(entry('() => ({ require: typeof require })')));
		expect(result).toMatchObject({ ok: true, value: { require: 'undefined' } });
	});

	it('cannot make a network call with fetch', async () => {
		const result = await run(
			invocation(
				entry(
					'async () => { try { await fetch("http://127.0.0.1:1/"); return { reached: true }; } catch (e) { return { reached: false, denied: String((e && e.message) || e) }; } }'
				)
			)
		);

		expect(result.ok).toBe(true);

		if (result.ok) {
			const value = result.value as Record<string, unknown>;
			expect(value['reached']).toBe(false);
			expect(String(value['denied'])).toMatch(/disabled|not supported/i);
		}
	});

	it('cannot read host files via node:fs', async () => {
		const result = await run(
			invocation(
				entry(
					'async () => { try { const fs = await import("node:fs"); fs.readFileSync("/etc/hostname"); return { read: true }; } catch (e) { return { read: false, denied: String((e && e.message) || e) }; } }'
				)
			)
		);

		expect(result.ok).toBe(true);

		if (result.ok) {
			const value = result.value as Record<string, unknown>;
			expect(value['read']).toBe(false);
			expect(String(value['denied'])).toMatch(/disabled|access/i);
		}
	});

	it('cannot reach host authority through a Function escape', async () => {
		process.env['CONFINED_PROBE_SECRET'] = 'host-secret-must-not-leak';

		try {
			const result = await run(
				invocation(
					entry(
						'() => { const g = Function("return this")(); return { hostSecret: (g.process && g.process.env) ? (g.process.env.CONFINED_PROBE_SECRET ?? null) : null, require: typeof g.require }; }'
					)
				)
			);

			expect(result.ok).toBe(true);

			if (result.ok) {
				const value = result.value as Record<string, unknown>;
				expect(value['hostSecret']).toBeNull();
				expect(value['require']).toBe('undefined');
			}
		} finally {
			delete process.env['CONFINED_PROBE_SECRET'];
		}
	});

	it('rejects an internal cairncms import as an invalid entry', async () => {
		const result = await run(invocation(`import x from '@cairncms/api';\n${entry('() => ({})')}`));
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid-entry' } });
	});

	it('rejects an unresolved import as an invalid entry', async () => {
		const result = await run(invocation(`import x from 'some-unresolved-pkg';\n${entry('() => ({})')}`));
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid-entry' } });
	});

	it('bounds a CPU loop with a resource timeout', async () => {
		const result = await run(
			invocation(entry('() => { while (true) {} }'), { limits: { ...LIMITS, cpuTimeoutMs: 300 } })
		);

		expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('bounds an oversized allocation (memory limit) as a failure, never a success', async () => {
		const result = await run(
			invocation(entry('() => { const a = new Array(50000000).fill(7); return a.length; }'), {
				limits: { ...LIMITS, memoryBytes: 16 * 1024 * 1024 },
			})
		);

		// QuickJS may surface the memory limit as a catchable guest error or an
		// engine-level resource interrupt, but it must never succeed. The
		// process-level runaway-allocation case is bounded by the supervisor wall-clock kill.
		expect(result.ok).toBe(false);
		if (!result.ok) expect(['guest-error', 'timeout']).toContain(result.error.code);
	});

	it('rejects a non-JSON-safe result', async () => {
		const result = await run(invocation(entry('() => { const a = {}; a.self = a; return a; }')));
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid-result' } });
	});

	it('surfaces a guest throw as a generic guest error without leaking the message', async () => {
		const result = await run(invocation(entry('() => { throw new Error("boom sk_live_leaked_secret"); }')));

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.code).toBe('guest-error');
			expect(result.error.message).toBe('the operation failed');
			expect(result.error.message).not.toContain('boom');
			expect(result.error.message).not.toContain('sk_live_leaked_secret');
		}
	});

	it('rejects an entry whose config id does not match the contribution id', async () => {
		const wrongId = `var CairnOperation = { default: { id: 'flow-operation.other', handler: () => ({ ok: true }) } };`;
		const result = await run(invocation(wrongId));

		expect(result).toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
	});

	it('rejects a raw export-default entry', async () => {
		const result = await run(invocation(`export default { id: 'x', handler: () => ({}) };`));
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid-entry' } });
	});

	it('rejects an entry whose default export has no handler', async () => {
		const result = await run(invocation(`var CairnOperation = { default: { id: 'x' } };`));
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid-entry' } });
	});

	it('bridges guest host calls to the host bridge and returns the reply', async () => {
		const calls: Array<{ method: string; args: unknown }> = [];

		const bridge: ConfinedHostBridge = async (call) => {
			calls.push(call);
			if (call.method === 'request.send') return { ok: true, value: { status: 204 } };
			return { ok: true, value: null };
		};

		const result = await run(
			invocation(
				entry(
					'async ({ options }, { host }) => { await host.log.info("hi"); const res = await host.request.send({ url: options.url, method: "POST" }); return { ok: res.ok, status: res.value.status }; }'
				),
				{ options: { url: 'https://api.example.com/x' } }
			),
			bridge
		);

		expect(result).toEqual({ ok: true, value: { ok: true, status: 204 } });
		expect(calls.map((call) => call.method)).toEqual(['log.info', 'request.send']);
		expect(calls[1]?.args).toMatchObject({ url: 'https://api.example.com/x', method: 'POST' });
	});

	it('returns the unsupported reply from the default bridge', async () => {
		const result = await run(
			invocation(
				entry(
					'async (_payload, { host }) => { const res = await host.settings.get("token"); return { ok: res.ok, code: res.error && res.error.code }; }'
				)
			)
		);

		expect(result).toEqual({ ok: true, value: { ok: false, code: 'unsupported' } });
	});
});
