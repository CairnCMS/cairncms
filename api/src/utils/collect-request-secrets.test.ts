import type { Request } from 'express';
import { describe, expect, test } from 'vitest';
import { collectRequestSecrets } from './collect-request-secrets.js';

function makeRequest(overrides: Record<string, unknown> = {}): Request {
	return { token: null, cookies: {}, headers: {}, query: {}, body: undefined, ...overrides } as unknown as Request;
}

describe('collectRequestSecrets', () => {
	test('collects the bare bearer token', () => {
		expect(collectRequestSecrets(makeRequest({ token: 'bare-token-value' })).has('bare-token-value')).toBe(true);
	});

	test('ignores a null, empty, or whitespace token', () => {
		expect(collectRequestSecrets(makeRequest({ token: null })).size).toBe(0);
		expect(collectRequestSecrets(makeRequest({ token: '' })).size).toBe(0);
		expect(collectRequestSecrets(makeRequest({ token: '   ' })).size).toBe(0);
	});

	test('collects scalar leaves of cookie values regardless of cookie name', () => {
		const secrets = collectRequestSecrets(makeRequest({ cookies: { session: 'session-secret', pref: 'dark' } }));
		expect(secrets.has('session-secret')).toBe(true);
		expect(secrets.has('dark')).toBe(true);
	});

	test('reduces a JSON object cookie to its scalar leaves, excluding booleans', () => {
		const secrets = collectRequestSecrets(
			makeRequest({ cookies: { data: { token: 'nested-secret', n: 42, flag: true } } })
		);

		expect(secrets.has('nested-secret')).toBe(true);
		expect(secrets.has('42')).toBe(true);
		expect(secrets.has('true')).toBe(false);
	});

	test('collects values under sensitive keys in headers, query, and body but not ordinary keys', () => {
		const secrets = collectRequestSecrets(
			makeRequest({
				headers: { authorization: 'Bearer header-token' },
				query: { access_token: 'query-token' },
				body: { password: 'body-secret', note: 'visible' },
			})
		);

		expect(secrets.has('Bearer header-token')).toBe(true);
		expect(secrets.has('query-token')).toBe(true);
		expect(secrets.has('body-secret')).toBe(true);
		expect(secrets.has('visible')).toBe(false);
	});
});
