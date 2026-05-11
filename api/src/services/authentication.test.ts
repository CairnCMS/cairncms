import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidCredentialsException } from '../exceptions/index.js';
import { AuthenticationService } from './authentication.js';
import { SettingsService } from './settings.js';

vi.mock('../../src/database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

vi.mock('../env', () => {
	const MOCK_ENV = {
		SECRET: 'test-secret-for-jwt',
		PUBLIC_URL: 'http://localhost:8055',
		LOGIN_STALL_TIME: 0,
		EXTENSIONS_PATH: './extensions',
		EMAIL_TRANSPORT: 'sendmail',
	};

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

vi.mock('../emitter.js', () => ({
	default: {
		emitFilter: vi.fn(async (_event, payload) => payload),
		emitAction: vi.fn(),
	},
}));

const mockLocalDriver = {
	getUserID: vi.fn(),
	login: vi.fn(),
};

vi.mock('../auth.js', () => ({
	getAuthProvider: vi.fn(() => mockLocalDriver),
	DEFAULT_AUTH_PROVIDER: 'default',
}));

const testSchema = {
	collections: {},
	relations: [],
} as SchemaOverview;

describe('Integration Tests', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeAll(async () => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	beforeEach(() => {
		mockLocalDriver.getUserID.mockReset();
		mockLocalDriver.login.mockReset();
	});

	afterEach(() => {
		tracker.reset();
	});

	describe('Services / Authentication', () => {
		describe('login — local-login failure paths surface a uniform error', () => {
			it('throws InvalidCredentialsException when the email does not exist', async () => {
				mockLocalDriver.getUserID.mockRejectedValueOnce(new InvalidCredentialsException());

				const service = new AuthenticationService({
					knex: db,
					schema: testSchema,
				});

				await expect(
					service.login('default', { email: 'nobody@example.com', password: 'whatever' })
				).rejects.toBeInstanceOf(InvalidCredentialsException);
			});

			it('throws InvalidCredentialsException when the email belongs to a different provider', async () => {
				mockLocalDriver.getUserID.mockResolvedValueOnce('sso-user-id');

				tracker.on.select(/select.*from "directus_users"/).response({
					id: 'sso-user-id',
					first_name: 'Sso',
					last_name: 'User',
					email: 'sso@example.com',
					password: 'hashed',
					status: 'active',
					role: 'role-id',
					admin_access: false,
					app_access: true,
					tfa_secret: null,
					provider: 'openid',
					external_identifier: 'sso-external-id',
					auth_data: null,
				});

				const service = new AuthenticationService({
					knex: db,
					schema: testSchema,
				});

				await expect(
					service.login('default', { email: 'sso@example.com', password: 'whatever' })
				).rejects.toBeInstanceOf(InvalidCredentialsException);
			});

			it('throws InvalidCredentialsException when the password is wrong for a local user', async () => {
				mockLocalDriver.getUserID.mockResolvedValueOnce('local-user-id');
				mockLocalDriver.login.mockRejectedValueOnce(new InvalidCredentialsException());

				tracker.on.select(/select.*from "directus_users"/).response({
					id: 'local-user-id',
					first_name: 'Local',
					last_name: 'User',
					email: 'local@example.com',
					password: 'hashed',
					status: 'active',
					role: 'role-id',
					admin_access: false,
					app_access: true,
					tfa_secret: null,
					provider: 'default',
					external_identifier: null,
					auth_data: null,
				});

				vi.spyOn(SettingsService.prototype, 'readSingleton').mockResolvedValueOnce({ auth_login_attempts: null });

				const service = new AuthenticationService({
					knex: db,
					schema: testSchema,
				});

				await expect(
					service.login('default', { email: 'local@example.com', password: 'wrong' })
				).rejects.toBeInstanceOf(InvalidCredentialsException);
			});
		});
	});
});
