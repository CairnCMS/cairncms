import { FailedValidationException } from '@cairncms/exceptions';
import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from './authorization.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

const testSchema = {
	collections: {
		directus_users: {
			collection: 'directus_users',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: {
					field: 'id',
					defaultValue: null,
					nullable: true,
					generated: true,
					type: 'uuid',
					dbType: 'uuid',
					precision: null,
					scale: null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				},
				role: {
					field: 'role',
					defaultValue: null,
					nullable: true,
					generated: false,
					type: 'uuid',
					dbType: 'uuid',
					precision: null,
					scale: null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				},
			},
		},
	},
	relations: [],
} as SchemaOverview;

describe('AuthorizationService.validatePayload — _in filter with empty array (GHSA-hxgm-ghmv-xjjm)', () => {
	let db: MockedFunction<Knex>;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		createTracker(db);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('throws FailedValidationException when permission validation carries _in [] and the payload would otherwise pass', () => {
		const accountability: Accountability = {
			role: 'restricted-editor-role-uuid',
			user: 'user-uuid',
			admin: false,
			app: true,
			permissions: [
				{
					id: 1,
					role: 'restricted-editor-role-uuid',
					collection: 'directus_users',
					action: 'update',
					permissions: {},
					validation: { role: { _in: [] } },
					presets: {},
					fields: ['*'],
				},
			],
		};

		const service = new AuthorizationService({
			knex: db,
			schema: testSchema,
			accountability,
		});

		let thrown: unknown;

		try {
			service.validatePayload('update', 'directus_users', { role: 'admin-role-uuid' });
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeDefined();
		expect(Array.isArray(thrown)).toBe(true);
		expect((thrown as unknown[]).length).toBeGreaterThan(0);
		expect((thrown as unknown[])[0]).toBeInstanceOf(FailedValidationException);
	});

	it('returns the payload without throwing when permission validation carries _in with a matching value', () => {
		const accountability: Accountability = {
			role: 'restricted-editor-role-uuid',
			user: 'user-uuid',
			admin: false,
			app: true,
			permissions: [
				{
					id: 1,
					role: 'restricted-editor-role-uuid',
					collection: 'directus_users',
					action: 'update',
					permissions: {},
					validation: { role: { _in: ['some-allowed-role-uuid'] } },
					presets: {},
					fields: ['*'],
				},
			],
		};

		const service = new AuthorizationService({
			knex: db,
			schema: testSchema,
			accountability,
		});

		const result = service.validatePayload('update', 'directus_users', {
			role: 'some-allowed-role-uuid',
		});

		expect(result).toStrictEqual({ role: 'some-allowed-role-uuid' });
	});
});
