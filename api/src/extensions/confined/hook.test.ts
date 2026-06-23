import { describe, expect, it } from 'vitest';
import {
	HOOK_META_BYTES_MAX,
	HOOK_PAYLOAD_BYTES_MAX,
	runConfinedActionHook,
	runConfinedFilterHook,
	type ConfinedFilterHookRequest,
	type ConfinedHookDeps,
	type ConfinedHookRequest,
} from './hook.js';
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

function filterRequest(overrides: Partial<ConfinedFilterHookRequest> = {}): ConfinedFilterHookRequest {
	return {
		extensionId: 'ext-1',
		contributionId: 'my-hook',
		entrySource: 'var CairnHook = { default: { id: "my-hook", filters: {} } };',
		capabilities: {},
		event: 'items.create',
		payload: { title: 'x' },
		meta: { collection: 'articles' },
		accountability: null,
		...overrides,
	};
}

function actionRequest(overrides: Partial<ConfinedHookRequest> = {}): ConfinedHookRequest {
	return {
		extensionId: 'ext-1',
		contributionId: 'my-hook',
		entrySource: 'var CairnHook = { default: { id: "my-hook", actions: {} } };',
		capabilities: {},
		event: 'items.create',
		meta: { collection: 'articles' },
		accountability: null,
		...overrides,
	};
}

function deps(overrides: Partial<ConfinedHookDeps> = {}): ConfinedHookDeps {
	return {
		invoke: async () => ({ ok: true, value: { unchanged: true } }),
		log: () => undefined,
		brokerLimits: BROKER_LIMITS,
		runtimeLimits: RUNTIME_LIMITS,
		settingsAccess: () => EMPTY_SETTINGS_ACCESS,
		...overrides,
	};
}

describe('runConfinedFilterHook', () => {
	it('hands the child the event firing under the event-filter activation', async () => {
		let seen: ConfinedInvocation | undefined;

		const result = await runConfinedFilterHook(
			filterRequest({ accountability: { user: 'u-1', role: 'r-1', admin: false, ip: '10.0.0.1' } as never }),
			deps({
				invoke: async (invocation) => {
					seen = invocation;
					return { ok: true, value: { unchanged: false, payload: { title: 'changed' } } };
				},
			})
		);

		expect(result).toEqual({ ok: true, unchanged: false, payload: { title: 'changed' } });
		expect(seen?.activation).toBe('event-filter');

		expect(seen?.input).toEqual({
			event: 'items.create',
			payload: { title: 'x' },
			meta: { collection: 'articles' },
		});

		expect(seen?.accountability).toEqual({ user: 'u-1', role: 'r-1', admin: false });
	});

	it('carries the explicit no-change envelope through', async () => {
		const result = await runConfinedFilterHook(
			filterRequest(),
			deps({ invoke: async () => ({ ok: true, value: { unchanged: true } }) })
		);

		expect(result).toEqual({ ok: true, unchanged: true });
	});

	it('fails closed on a malformed envelope', async () => {
		for (const value of [
			null,
			'changed',
			{ unchanged: 'yes' },
			{ payload: {} },
			{ unchanged: false, payload: null, extra: 1 },
			[],
		]) {
			const result = await runConfinedFilterHook(filterRequest(), deps({ invoke: async () => ({ ok: true, value }) }));

			expect(result, JSON.stringify(value)).toEqual({ ok: false });
		}
	});

	it('fails closed on a guest failure or a thrown supervisor', async () => {
		const guestFailure = await runConfinedFilterHook(
			filterRequest(),
			deps({ invoke: async () => ({ ok: false, error: { code: 'guest-error', message: 'the event hook failed' } }) })
		);

		expect(guestFailure).toEqual({ ok: false });

		const thrown = await runConfinedFilterHook(
			filterRequest(),
			deps({
				invoke: async () => {
					throw new Error('the child crashed at /home/alison/secret');
				},
			})
		);

		expect(thrown).toEqual({ ok: false });
	});

	it('refuses an oversized payload before the child', async () => {
		let invoked = false;

		const result = await runConfinedFilterHook(
			filterRequest({ payload: { blob: 'x'.repeat(HOOK_PAYLOAD_BYTES_MAX) } }),
			deps({
				invoke: async () => {
					invoked = true;
					return { ok: true, value: { unchanged: true } };
				},
			})
		);

		expect(result).toEqual({ ok: false });
		expect(invoked).toBe(false);
	});

	it('refuses unserializable or oversized meta before the child', async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic['self'] = cyclic;

		let invoked = false;

		const dependencies = deps({
			invoke: async () => {
				invoked = true;
				return { ok: true, value: { unchanged: true } };
			},
		});

		expect(await runConfinedFilterHook(filterRequest({ meta: cyclic }), dependencies)).toEqual({ ok: false });

		expect(
			await runConfinedFilterHook(filterRequest({ meta: { blob: 'x'.repeat(HOOK_META_BYTES_MAX) } }), dependencies)
		).toEqual({ ok: false });

		expect(invoked).toBe(false);
	});
});

describe('runConfinedActionHook', () => {
	it('hands the child the event firing under the event-action activation', async () => {
		let seen: ConfinedInvocation | undefined;

		const result = await runConfinedActionHook(
			actionRequest(),
			deps({
				invoke: async (invocation) => {
					seen = invocation;
					return { ok: true, value: { done: true } };
				},
			})
		);

		expect(result).toEqual({ ok: true });
		expect(seen?.activation).toBe('event-action');
		expect(seen?.input).toEqual({ event: 'items.create', meta: { collection: 'articles' } });
	});

	it('fails closed on a malformed completion or a guest failure', async () => {
		for (const value of [null, {}, { done: false }, { done: 'yes' }]) {
			const result = await runConfinedActionHook(actionRequest(), deps({ invoke: async () => ({ ok: true, value }) }));
			expect(result, JSON.stringify(value)).toEqual({ ok: false });
		}

		const failure = await runConfinedActionHook(
			actionRequest(),
			deps({ invoke: async () => ({ ok: false, error: { code: 'timeout', message: 'the event hook failed' } }) })
		);

		expect(failure).toEqual({ ok: false });
	});

	it('refuses oversized meta before the child', async () => {
		let invoked = false;

		const result = await runConfinedActionHook(
			actionRequest({ meta: { blob: 'x'.repeat(HOOK_META_BYTES_MAX) } }),
			deps({
				invoke: async () => {
					invoked = true;
					return { ok: true, value: { done: true } };
				},
			})
		);

		expect(result).toEqual({ ok: false });
		expect(invoked).toBe(false);
	});
});
