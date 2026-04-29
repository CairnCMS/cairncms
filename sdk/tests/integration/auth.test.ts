import { describe, expect, it } from 'vitest';
import { authentication, createCairnCMS, readMe, rest, staticToken, updateMe } from '../../src/index.js';
import { ENV_KEYS } from './helpers/constants.js';

const URL = process.env[ENV_KEYS.url]!;
const EMAIL = process.env[ENV_KEYS.adminEmail]!;
const PASSWORD = process.env[ENV_KEYS.adminPassword]!;

describe('auth flow', () => {
	it('logs in with email/password and receives access + refresh tokens', async () => {
		const client = createCairnCMS(URL).with(authentication('json')).with(rest());

		const result = await client.login(EMAIL, PASSWORD);

		expect(result.access_token).toBeTypeOf('string');
		expect(result.refresh_token).toBeTypeOf('string');
		expect(result.expires).toBeTypeOf('number');
	});

	it('uses the access token on subsequent requests', async () => {
		const client = createCairnCMS(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);

		const me = await client.request(readMe());

		expect(me['email']).toBe(EMAIL);
	});

	it('refresh flow extends the session', async () => {
		const client = createCairnCMS(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);

		const refreshed = await client.refresh();

		expect(refreshed.access_token).toBeTypeOf('string');
		expect(refreshed.refresh_token).toBeTypeOf('string');
	});

	it('logout revokes the session', async () => {
		const client = createCairnCMS(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);
		await client.logout();

		// After logout, an authenticated call should fail
		await expect(client.request(readMe())).rejects.toThrow();
	});

	it('static token auth: authenticates requests with a pre-issued token', async () => {
		// Obtain a token via one client, then hand it to a staticToken-authenticated
		// client to verify the alternate auth flow.
		const seed = createCairnCMS(URL).with(authentication('json')).with(rest());
		const { access_token } = await seed.login(EMAIL, PASSWORD);

		const client = createCairnCMS(URL).with(staticToken(access_token!)).with(rest());
		const me = await client.request(readMe());

		expect(me['email']).toBe(EMAIL);
	});

	it('updateMe: updates the current user profile', async () => {
		const client = createCairnCMS(URL).with(authentication('json')).with(rest());
		await client.login(EMAIL, PASSWORD);

		const updated = await client.request(updateMe({ first_name: 'Admin', last_name: 'User' }));

		expect(updated['first_name']).toBe('Admin');
		expect(updated['last_name']).toBe('User');
	});
});
