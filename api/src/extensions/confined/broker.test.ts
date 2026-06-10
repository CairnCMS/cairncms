import { describe, expect, it } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import { createConfinedHostBroker, type ConfinedHostBrokerDeps, type ConfinedLogEntry } from './broker.js';
import { SETTINGS_VALUE_BYTES } from './sandbox-limits.js';
import { ConfinedSecretScope } from './secret-scope.js';
import type { ConfinedHostCallContext } from './types.js';

const context: ConfinedHostCallContext = { extensionId: 'ext-1', contributionId: 'contrib-1', operationId: 'op-1' };

const liveSignal = new AbortController().signal;

function makeBroker(overrides: Partial<ConfinedHostBrokerDeps> = {}, scope = new ConfinedSecretScope()) {
	const logged: ConfinedLogEntry[] = [];

	const deps: ConfinedHostBrokerDeps = {
		capabilities: {},
		log: (entry) => logged.push(entry),
		settings: { declared: [], value: () => null, hasSecret: () => false },
		limits: { settingsValueBytes: SETTINGS_VALUE_BYTES },
		...overrides,
	};

	return { dispatch: createConfinedHostBroker(deps, scope), logged, scope };
}

describe('createConfinedHostBroker log', () => {
	it('denies every log level without the log capability', async () => {
		const { dispatch, logged } = makeBroker();

		for (const method of ['log.debug', 'log.info', 'log.warn', 'log.error']) {
			const reply = await dispatch({ method, args: { message: 'hello' } }, context, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}

		expect(logged).toHaveLength(0);
	});

	it('emits to the sink with the level and context under the capability', async () => {
		const { dispatch, logged } = makeBroker({ capabilities: { log: true } });

		const reply = await dispatch(
			{ method: 'log.warn', args: { message: 'careful', meta: { n: 1 } } },
			context,
			liveSignal
		);

		expect(reply).toEqual({ ok: true, value: null });
		expect(logged).toEqual([{ level: 'warn', message: 'careful', meta: { n: 1 }, context }]);
	});

	it('redacts a declared-sensitive key and its propagated value before the sink', async () => {
		const { dispatch, logged } = makeBroker({
			capabilities: { log: true },
			settings: {
				declared: [{ key: 'apiKey', sensitive: true }],
				value: () => null,
				hasSecret: () => false,
			},
		});

		await dispatch(
			{
				method: 'log.info',
				args: { message: 'sent', meta: { apiKey: 'sk_live_1234567890', note: 'used sk_live_1234567890 today' } },
			},
			context,
			liveSignal
		);

		const meta = logged[0]?.meta as Record<string, unknown>;
		expect(meta['apiKey']).toBe(REDACT_TEXT);
		expect(meta['note']).not.toContain('sk_live_1234567890');
	});

	it('redacts scope tokens and resolved secrets from log output', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });
		scope.registerResolved('resolved_real_secret_value');

		const { dispatch, logged } = makeBroker({ capabilities: { log: true } }, scope);

		await dispatch(
			{ method: 'log.info', args: { message: `token ${ref} and resolved_real_secret_value` } },
			context,
			liveSignal
		);

		const message = String(logged[0]?.message);
		expect(message).not.toContain(ref);
		expect(message).not.toContain('resolved_real_secret_value');
		expect(message).toContain(REDACT_TEXT);
	});
});

describe('createConfinedHostBroker settings', () => {
	it('denies settings.get without the read capability', async () => {
		const { dispatch } = makeBroker({ capabilities: { settings: ['write'] } });
		const reply = await dispatch({ method: 'settings.get', args: { key: 'mode' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
	});

	it('rejects a missing or non-string key', async () => {
		const { dispatch } = makeBroker({ capabilities: { settings: ['read'] } });

		expect(await dispatch({ method: 'settings.get', args: {} }, context, liveSignal)).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' },
		});

		expect(await dispatch({ method: 'settings.get', args: { key: 7 } }, context, liveSignal)).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' },
		});
	});

	it('returns null for an undeclared key even when the source would have a value', async () => {
		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: { declared: [], value: () => 'stale', hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'undeclared' } }, context, liveSignal);
		expect(reply).toEqual({ ok: true, value: null });
	});

	it('returns a declared non-sensitive value', async () => {
		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: { declared: [{ key: 'mode', sensitive: false }], value: () => 'fast', hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'mode' } }, context, liveSignal);
		expect(reply).toEqual({ ok: true, value: 'fast' });
	});

	it('mints a fresh per-call reference for a sensitive setting and never the value', async () => {
		const scope = new ConfinedSecretScope();

		const { dispatch } = makeBroker(
			{
				capabilities: { settings: ['read'] },
				settings: {
					declared: [{ key: 'apiKey', sensitive: true }],
					value: () => 'sk_live_raw_never_crosses',
					hasSecret: () => true,
				},
			},
			scope
		);

		const first = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);
		const second = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);

		expect(first).toMatchObject({ ok: true, value: { kind: 'secret-reference' } });
		expect(JSON.stringify(first)).not.toContain('sk_live_raw_never_crosses');

		const firstRef = (first as { value: { ref: string } }).value.ref;
		const secondRef = (second as { value: { ref: string } }).value.ref;

		expect(firstRef).not.toBe(secondRef);
		expect(scope.refs()).toContain(firstRef);

		expect(scope.resolve(firstRef)).toEqual({
			kind: 'extension-setting',
			extensionId: 'ext-1',
			contributionId: 'contrib-1',
			key: 'apiKey',
		});
	});

	it('returns null for a sensitive setting with no backing secret', async () => {
		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: { declared: [{ key: 'apiKey', sensitive: true }], value: () => null, hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);
		expect(reply).toEqual({ ok: true, value: null });
	});

	it('refuses an over-cap setting value before it can reach the reply', async () => {
		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: {
				declared: [{ key: 'blob', sensitive: false }],
				value: () => 'x'.repeat(SETTINGS_VALUE_BYTES + 1),
				hasSecret: () => false,
			},
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'blob' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('treats a key with conflicting duplicate declarations as sensitive, in either order and any case', async () => {
		for (const declared of [
			[
				{ key: 'apiKey', sensitive: false },
				{ key: 'apiKey', sensitive: true },
			],
			[
				{ key: 'apiKey', sensitive: true },
				{ key: 'apiKey', sensitive: false },
			],
			[
				{ key: 'apikey', sensitive: false },
				{ key: 'ApiKey', sensitive: true },
			],
			[
				{ key: 'APIKEY', sensitive: true },
				{ key: 'apiKey', sensitive: false },
			],
		]) {
			const { dispatch } = makeBroker({
				capabilities: { settings: ['read'] },
				settings: { declared, value: () => 'sk_live_raw_never_crosses', hasSecret: () => true },
			});

			const reply = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);

			expect(reply).toMatchObject({ ok: true, value: { kind: 'secret-reference' } });
			expect(JSON.stringify(reply)).not.toContain('sk_live_raw_never_crosses');
		}
	});

	it('measures the cap against the serialized value, so escaping inflation cannot pass it', async () => {
		// Raw length is under the cap, but every quote escapes to two characters in
		// JSON, so the serialized form is roughly double and breaches it.
		const quoteHeavy = '"'.repeat(SETTINGS_VALUE_BYTES - 1024);

		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: { declared: [{ key: 'blob', sensitive: false }], value: () => quoteHeavy, hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'blob' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('settles with a timeout when the settings source ignores the abort signal', async () => {
		const controller = new AbortController();

		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: {
				declared: [{ key: 'slow', sensitive: false }],
				value: () => new Promise(() => undefined),
				hasSecret: () => false,
			},
		});

		const pending = dispatch({ method: 'settings.get', args: { key: 'slow' } }, context, controller.signal);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('passes the per-call signal to the settings source', async () => {
		const seen: AbortSignal[] = [];

		const { dispatch } = makeBroker({
			capabilities: { settings: ['read'] },
			settings: {
				declared: [{ key: 'mode', sensitive: false }],
				value: (_key, signal) => {
					seen.push(signal);
					return 'fast';
				},
				hasSecret: () => false,
			},
		});

		await dispatch({ method: 'settings.get', args: { key: 'mode' } }, context, liveSignal);

		expect(seen).toEqual([liveSignal]);
	});
});

describe('createConfinedHostBroker dispatch', () => {
	it('answers an unknown method with unsupported', async () => {
		const { dispatch } = makeBroker({ capabilities: { log: true } });
		const reply = await dispatch({ method: 'files.upload', args: {} }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'unsupported' } });
	});

	it('answers an aborted call with a timeout', async () => {
		const controller = new AbortController();
		controller.abort();

		const { dispatch, logged } = makeBroker({ capabilities: { log: true } });
		const reply = await dispatch({ method: 'log.info', args: { message: 'late' } }, context, controller.signal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'timeout' } });
		expect(logged).toHaveLength(0);
	});
});
