import { describe, expect, test } from 'vitest';
import { REDACT_TEXT } from '../constants.js';
import { collectSensitiveValues, redactFlowLog } from './redact-flow-log.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.HEADER_PAYLOAD_LONG_ENOUGH_TO_BE_REAL_TOKEN';
const OTHER_TOKEN = 'another-distinct-token-value-also-long-enough';

describe('collectSensitiveValues', () => {
	test('returns empty set for non-objects', () => {
		expect(collectSensitiveValues(null).size).toBe(0);
		expect(collectSensitiveValues(undefined).size).toBe(0);
		expect(collectSensitiveValues('plain string').size).toBe(0);
		expect(collectSensitiveValues(42).size).toBe(0);
	});

	test('collects string values at every sensitive key', () => {
		const source = {
			headers: {
				authorization: `Bearer ${TOKEN}`,
				cookie: `session=${TOKEN}`,
				'set-cookie': `session=${OTHER_TOKEN}`,
			},
			body: { access_token: TOKEN, refresh_token: OTHER_TOKEN },
		};

		const collected = collectSensitiveValues(source);
		expect(collected.has(`Bearer ${TOKEN}`)).toBe(true);
		expect(collected.has(`session=${TOKEN}`)).toBe(true);
		expect(collected.has(`session=${OTHER_TOKEN}`)).toBe(true);
		expect(collected.has(TOKEN)).toBe(true);
		expect(collected.has(OTHER_TOKEN)).toBe(true);
	});

	test('collects values at the expanded sensitive-key set (password, token, tfa_secret, etc.)', () => {
		const pwValue = 'webhook-body-password-1234567890';
		const tokenValue = 'long-static-token-abcdefghijkl';
		const tfaValue = 'tfa-secret-mnopqrstuvwxyz';
		const extIdValue = 'oauth|google|long-external-id';
		const authDataValue = 'auth-data-blob-9876543210abcd';
		const credsValue = 'creds-blob-1234567890abcdef';
		const aiKeyValue = 'sk-ai-key-1234567890abcdefgh';

		const source = {
			body: {
				password: pwValue,
				token: tokenValue,
				tfa_secret: tfaValue,
				external_identifier: extIdValue,
				auth_data: authDataValue,
				credentials: credsValue,
				ai_openai_api_key: aiKeyValue,
			},
		};

		const collected = collectSensitiveValues(source);
		expect(collected.has(pwValue)).toBe(true);
		expect(collected.has(tokenValue)).toBe(true);
		expect(collected.has(tfaValue)).toBe(true);
		expect(collected.has(extIdValue)).toBe(true);
		expect(collected.has(authDataValue)).toBe(true);
		expect(collected.has(credsValue)).toBe(true);
		expect(collected.has(aiKeyValue)).toBe(true);
	});

	test('is case-insensitive on key matching', () => {
		const source = { Headers: { Authorization: `Bearer ${TOKEN}` } };
		const collected = collectSensitiveValues(source);
		expect(collected.has(`Bearer ${TOKEN}`)).toBe(true);
	});

	test('skips short sensitive values below the length threshold', () => {
		const source = { body: { access_token: 'short' } };
		expect(collectSensitiveValues(source).size).toBe(0);
	});

	test('skips empty and whitespace-only sensitive values', () => {
		const source = { body: { access_token: '', refresh_token: '            ' } };
		expect(collectSensitiveValues(source).size).toBe(0);
	});

	test('recurses through arrays', () => {
		const source = { items: [{ body: { access_token: TOKEN } }] };
		const collected = collectSensitiveValues(source);
		expect(collected.has(TOKEN)).toBe(true);
	});

	test('does not infinite-loop on cycles', () => {
		const source: Record<string, unknown> = { body: { access_token: TOKEN } };
		source['self'] = source;
		const collected = collectSensitiveValues(source);
		expect(collected.has(TOKEN)).toBe(true);
	});

	test('collects from non-plain objects under sensitive keys via toJSON', () => {
		const source = { body: { access_token: new URL(`https://example.com/?t=${TOKEN}`) } };
		const collected = collectSensitiveValues(source);
		expect(collected.has(`https://example.com/?t=${TOKEN}`)).toBe(true);
	});

	test('propagates sensitivity through arrays under a sensitive key', () => {
		const source = { body: { access_token: [TOKEN, OTHER_TOKEN] } };
		const collected = collectSensitiveValues(source);
		expect(collected.has(TOKEN)).toBe(true);
		expect(collected.has(OTHER_TOKEN)).toBe(true);
	});

	test('propagates sensitivity through nested plain objects under a sensitive key', () => {
		const source = { body: { access_token: { deep: { nested: TOKEN } } } };
		const collected = collectSensitiveValues(source);
		expect(collected.has(TOKEN)).toBe(true);
	});
});

describe('redactFlowLog — key-based', () => {
	test('redacts each sensitive key at top level', () => {
		const result = redactFlowLog({
			authorization: 'value',
			cookie: 'value',
			'set-cookie': 'value',
			access_token: 'value',
			refresh_token: 'value',
		});

		expect(result).toEqual({
			authorization: REDACT_TEXT,
			cookie: REDACT_TEXT,
			'set-cookie': REDACT_TEXT,
			access_token: REDACT_TEXT,
			refresh_token: REDACT_TEXT,
		});
	});

	test('redacts sensitive keys nested under plain objects', () => {
		const result = redactFlowLog({
			$trigger: {
				headers: { authorization: 'value' },
				body: { refresh_token: 'value' },
			},
		}) as any;

		expect(result.$trigger.headers.authorization).toBe(REDACT_TEXT);
		expect(result.$trigger.body.refresh_token).toBe(REDACT_TEXT);
	});

	test('matches sensitive keys case-insensitively', () => {
		const result = redactFlowLog({
			Authorization: 'value',
			COOKIE: 'value',
			Access_Token: 'value',
		}) as Record<string, unknown>;

		expect(result['Authorization']).toBe(REDACT_TEXT);
		expect(result['COOKIE']).toBe(REDACT_TEXT);
		expect(result['Access_Token']).toBe(REDACT_TEXT);
	});

	test('redacts sensitive keys nested inside arrays', () => {
		const result = redactFlowLog({
			records: [{ access_token: 'value' }, { other: 'fine' }],
		}) as any;

		expect(result.records[0].access_token).toBe(REDACT_TEXT);
		expect(result.records[1].other).toBe('fine');
	});

	test('redacts the expanded sensitive-key set under arbitrary parent paths', () => {
		const result = redactFlowLog({
			$trigger: {
				body: {
					password: 'value',
					token: 'value',
					tfa_secret: 'value',
					external_identifier: 'value',
					auth_data: 'value',
					credentials: 'value',
					ai_openai_api_key: 'value',
					ai_anthropic_api_key: 'value',
					ai_google_api_key: 'value',
					ai_openai_compatible_api_key: 'value',
				},
			},
		}) as any;

		expect(result.$trigger.body.password).toBe(REDACT_TEXT);
		expect(result.$trigger.body.token).toBe(REDACT_TEXT);
		expect(result.$trigger.body.tfa_secret).toBe(REDACT_TEXT);
		expect(result.$trigger.body.external_identifier).toBe(REDACT_TEXT);
		expect(result.$trigger.body.auth_data).toBe(REDACT_TEXT);
		expect(result.$trigger.body.credentials).toBe(REDACT_TEXT);
		expect(result.$trigger.body.ai_openai_api_key).toBe(REDACT_TEXT);
		expect(result.$trigger.body.ai_anthropic_api_key).toBe(REDACT_TEXT);
		expect(result.$trigger.body.ai_google_api_key).toBe(REDACT_TEXT);
		expect(result.$trigger.body.ai_openai_compatible_api_key).toBe(REDACT_TEXT);
	});
});

describe('redactFlowLog — value-based', () => {
	test('replaces a sensitive value when it is the entire string', () => {
		const sensitiveValues = new Set([TOKEN]);
		const result = redactFlowLog({ message: TOKEN }, sensitiveValues) as { message: string };
		expect(result.message).toBe(REDACT_TEXT);
	});

	test('replaces only the sensitive substring inside a larger string', () => {
		const sensitiveValues = new Set([TOKEN]);

		const result = redactFlowLog({ url: `https://example.com/?t=${TOKEN}&x=1` }, sensitiveValues) as { url: string };

		expect(result.url).toBe(`https://example.com/?t=${REDACT_TEXT}&x=1`);
	});

	test('does not redact when no sensitive values are provided', () => {
		const result = redactFlowLog({ message: TOKEN }) as { message: string };
		expect(result.message).toBe(TOKEN);
	});

	test('replaces every occurrence of a sensitive value in the same string', () => {
		const sensitiveValues = new Set([TOKEN]);
		const result = redactFlowLog({ s: `${TOKEN} and ${TOKEN}` }, sensitiveValues) as { s: string };
		expect(result.s).toBe(`${REDACT_TEXT} and ${REDACT_TEXT}`);
	});
});

describe('redactFlowLog — JSON-safe normalization', () => {
	test('Date becomes its ISO string representation', () => {
		const date = new Date('2026-05-01T12:00:00.000Z');
		const result = redactFlowLog({ when: date }) as { when: unknown };
		expect(result.when).toBe('2026-05-01T12:00:00.000Z');
	});

	test('URL becomes its href string', () => {
		const url = new URL('https://example.com/path?x=1');
		const result = redactFlowLog({ url }) as { url: unknown };
		expect(result.url).toBe('https://example.com/path?x=1');
	});

	test('URL containing a sensitive value has the substring redacted within the href', () => {
		const sensitiveValues = new Set([TOKEN]);
		const url = new URL(`https://example.com/path?t=${TOKEN}`);
		const result = redactFlowLog({ url }, sensitiveValues) as { url: unknown };
		expect(result.url).toBe(`https://example.com/path?t=${REDACT_TEXT}`);
	});

	test('Buffer becomes its JSON representation', () => {
		const buf = Buffer.from('hello');
		const result = redactFlowLog({ data: buf }) as unknown as { data: { type: string; data: number[] } };
		expect(result.data).toEqual({ type: 'Buffer', data: [104, 101, 108, 108, 111] });
	});

	test('Set and Map serialize to empty plain objects', () => {
		const result = redactFlowLog({
			set: new Set(['a', 'b']),
			map: new Map([['k', 'v']]),
		}) as { set: unknown; map: unknown };

		expect(result.set).toEqual({});
		expect(result.map).toEqual({});
	});

	test('Error objects serialize to a plain object with name, message, stack, cause', () => {
		const err = new Error(`boom: ${TOKEN}`);
		const sensitiveValues = new Set([TOKEN]);
		const result = redactFlowLog({ err }, sensitiveValues) as unknown as { err: Record<string, unknown> };
		expect(result.err['name']).toBe('Error');
		expect(result.err['message']).toBe(`boom: ${REDACT_TEXT}`);
		expect(typeof result.err['stack']).toBe('string');
	});

	test('cycles produce a [Circular] placeholder instead of throwing', () => {
		const input: Record<string, unknown> = { headers: { authorization: 'value' } };
		input['self'] = input;
		const result = redactFlowLog(input) as Record<string, unknown>;
		expect((result['headers'] as Record<string, unknown>)['authorization']).toBe(REDACT_TEXT);
		expect(result['self']).toBe('[Circular]');
	});
});

describe('redactFlowLog — general', () => {
	test('passes JSON-safe non-sensitive values through unchanged', () => {
		const input = { method: 'POST', path: '/flows/trigger/abc', body: { count: 3 } };
		const result = redactFlowLog(input);
		expect(result).toEqual(input);
	});

	test('does not mutate the input object', () => {
		const input = { headers: { authorization: 'real-value' } };
		const snapshot = JSON.parse(JSON.stringify(input));
		redactFlowLog(input);
		expect(input).toEqual(snapshot);
	});

	test('preserves array structure', () => {
		const result = redactFlowLog([1, 'a', { x: 2 }]);
		expect(result).toEqual([1, 'a', { x: 2 }]);
	});
});
