import { afterEach, describe, expect, it, vi } from 'vitest';
import emitter from '../../emitter.js';
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
