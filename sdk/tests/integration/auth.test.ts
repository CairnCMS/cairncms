import { describe, expect, it } from 'vitest';
import { authentication, createDirectus, readMe, rest } from '../../src/index.js';
import { ENV_KEYS } from './helpers/constants.js';

const URL = process.env[ENV_KEYS.url]!;
const EMAIL = process.env[ENV_KEYS.adminEmail]!;
const PASSWORD = process.env[ENV_KEYS.adminPassword]!;

describe('auth flow', () => {
	it('logs in with email/password and receives access + refresh tokens', async () => {
		const client = createDirectus(URL).with(authentication('json')).with(rest());

		const result = await client.login(EMAIL, PASSWORD);

		expect(result.access_token).toBeTypeOf('string');
		expect(result.refresh_token).toBeTypeOf('string');
		expect(result.expires).toBeTypeOf('number');
	});

	it('uses the access token on subsequent requests', async () => {
		const client = createDirectus(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);

		const me = await client.request(readMe());

		expect(me.email).toBe(EMAIL);
	});

	it('refresh flow extends the session', async () => {
		const client = createDirectus(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);

		const refreshed = await client.refresh();

		expect(refreshed.access_token).toBeTypeOf('string');
		expect(refreshed.refresh_token).toBeTypeOf('string');
	});

	it('logout revokes the session', async () => {
		const client = createDirectus(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);
		await client.logout();

		// After logout, an authenticated call should fail
		await expect(client.request(readMe())).rejects.toThrow();
	});
});
