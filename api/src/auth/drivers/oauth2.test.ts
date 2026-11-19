import { ServiceUnavailableException } from '@cairncms/exceptions';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generators, Issuer } from 'openid-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import emitter from '../../emitter.js';
import { redactLogPayload } from '../../utils/error-log.js';
import { snapshotError } from '../../utils/error-snapshot.js';
import { collectSensitiveValuesExhaustive } from '../../utils/redact-sensitive.js';
import { OAuth2AuthDriver } from './oauth2.js';

vi.mock('../../emitter.js', () => ({
	default: {
		emitFilter: vi.fn(async (_event: string, payload: unknown) => payload),
		emitAction: vi.fn(),
	},
}));

vi.mock('../../database/index.js', () => ({
	default: vi.fn(() => ({})),
	getDatabaseClient: vi.fn(),
}));

vi.mock('../../env.js', () => {
	const MOCK_ENV = {
		SECRET: 'test-secret-for-jwt',
		PUBLIC_URL: 'http://localhost:8055',
		LOGIN_STALL_TIME: 0,
		EXTENSIONS_PATH: './extensions',
		EMAIL_TRANSPORT: 'sendmail',
	};

	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

function createDriver(refreshToken: string | undefined) {
	const updateOne = vi.fn(async () => 'user-1');
	const driver = Object.create(OAuth2AuthDriver.prototype) as OAuth2AuthDriver;

	driver.redirectUrl = 'http://localhost/auth/login/test/callback';
	driver.config = { provider: 'test' };
	(driver as any).schema = { collections: {}, relations: [] };

	driver.client = {
		oauthCallback: vi.fn(async () => ({ access_token: 'ACCESS', refresh_token: refreshToken })),
		userinfo: vi.fn(async () => ({ sub: 'external-id', email: 'user@example.com' })),
	} as any;

	driver.usersService = { updateOne } as any;
	(driver as any).fetchUserId = vi.fn(async () => 'user-1');

	return { driver, updateOne };
}

const payload = { code: 'CODE', codeVerifier: 'VERIFIER', state: 'STATE' };

describe('OAuth2 auth driver auth_data persistence', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('passes the computed refresh-token auth_data through the auth.update hook and persists the hook return', async () => {
		const { driver, updateOne } = createDriver('REFRESH');

		await driver.getUserID(payload);

		expect(emitter.emitFilter).toHaveBeenCalledTimes(1);

		expect(vi.mocked(emitter.emitFilter).mock.calls[0]![1]).toEqual({
			auth_data: JSON.stringify({ refreshToken: 'REFRESH' }),
		});

		expect(updateOne).toHaveBeenCalledWith('user-1', { auth_data: JSON.stringify({ refreshToken: 'REFRESH' }) });
	});

	it('passes auth_data as null when the provider returns no refresh token', async () => {
		const { driver, updateOne } = createDriver(undefined);

		await driver.getUserID(payload);

		expect(vi.mocked(emitter.emitFilter).mock.calls[0]![1]).toEqual({ auth_data: null });
		expect(updateOne).toHaveBeenCalledWith('user-1', { auth_data: null });
	});

	it('persists the auth_data value returned by the auth.update hook', async () => {
		const { driver, updateOne } = createDriver('REFRESH');
		vi.mocked(emitter.emitFilter).mockResolvedValueOnce({ auth_data: 'hook-modified' });

		await driver.getUserID(payload);

		expect(updateOne).toHaveBeenCalledWith('user-1', { auth_data: 'hook-modified' });
	});
});

describe('OAuth2 auth driver provider error details', () => {
	const SECRET = 'provider-secret-value-1234567890';

	async function rejectWithProviderError(description: string): Promise<unknown> {
		const server: Server = createServer((_req, res) => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(`{"error":"server_error","error_description":${description}}`);
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

		try {
			const { port } = server.address() as AddressInfo;
			const { driver } = createDriver(undefined);

			const issuer = new Issuer({
				issuer: 'test',
				authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
				token_endpoint: `http://127.0.0.1:${port}/token`,
				userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
			});

			driver.client = new issuer.Client({
				client_id: 'client',
				client_secret: 'client-secret',
				redirect_uris: [driver.redirectUrl],
				response_types: ['code'],
			});

			const codeVerifier = generators.codeVerifier();

			return await driver
				.getUserID({ code: 'CODE', codeVerifier, state: generators.codeChallenge(codeVerifier) })
				.catch((error: unknown) => error);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	it.each([
		['without', `{"password":"${SECRET}","echo":"${SECRET}"}`],
		['with', `{"__proto__":{"label":"ordinary"},"password":"${SECRET}","echo":"${SECRET}"}`],
	])('redacts a provider error description %s an own __proto__ key in the log payload', async (_label, description) => {
		const error = await rejectWithProviderError(description);

		expect(error).toBeInstanceOf(ServiceUnavailableException);

		const snapshot = snapshotError(error);
		const payload = redactLogPayload(snapshot, collectSensitiveValuesExhaustive(snapshot));

		expect(JSON.stringify(payload)).not.toContain(SECRET);
		expect((payload.err['extensions'] as any).message.echo).toBe(REDACT_TEXT);
	});
});
