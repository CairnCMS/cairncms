import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { MockClient, createTracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { ItemsService } from './items.js';
import { PresetsService } from './presets.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

const testSchema = {
	collections: {
		directus_presets: {
			collection: 'directus_presets',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: {
					field: 'id',
					defaultValue: null,
					nullable: false,
					generated: true,
					type: 'integer',
					dbType: 'integer',
					precision: null,
					scale: null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				},
				user: {
					field: 'user',
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
				collection: {
					field: 'collection',
					defaultValue: null,
					nullable: false,
					generated: false,
					type: 'string',
					dbType: 'varchar',
					precision: null,
					scale: null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				},
				layout: {
					field: 'layout',
					defaultValue: null,
					nullable: true,
					generated: false,
					type: 'string',
					dbType: 'varchar',
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

const CALLER_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRESET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('PresetsService — ownership validation (GHSA-3fff-gqw3-vj86)', () => {
	let db: MockedFunction<Knex>;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		createTracker(db);
	});

	beforeEach(() => {
		vi.clearAllMocks();

		vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue(PRESET_ID);
		vi.spyOn(ItemsService.prototype, 'createMany').mockResolvedValue([PRESET_ID]);
		vi.spyOn(ItemsService.prototype, 'updateOne').mockResolvedValue(PRESET_ID);
		vi.spyOn(ItemsService.prototype, 'updateMany').mockResolvedValue([PRESET_ID]);
		vi.spyOn(ItemsService.prototype, 'updateBatch').mockResolvedValue([PRESET_ID]);
	});

	function makeService(overrides: Partial<Accountability> = {}): PresetsService {
		const accountability: Accountability = {
			user: CALLER_USER,
			role: 'role-uuid',
			admin: false,
			app: true,
			ip: '127.0.0.1',
			...overrides,
		};

		return new PresetsService({ knex: db, schema: testSchema, accountability });
	}

	describe('bug-exposing — non-admin reassignment attempts', () => {
		it('updateOne with a user other than the caller throws ForbiddenException', async () => {
			const service = makeService();
			await expect(service.updateOne(PRESET_ID, { user: OTHER_USER })).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('updateMany with a user other than the caller throws ForbiddenException', async () => {
			const service = makeService();
			await expect(service.updateMany([PRESET_ID], { user: OTHER_USER })).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('updateBatch with any element having a user other than the caller throws ForbiddenException', async () => {
			const service = makeService();

			await expect(
				service.updateBatch([
					{ id: PRESET_ID, user: CALLER_USER },
					{ id: PRESET_ID, user: OTHER_USER },
				])
			).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('createOne with a user other than the caller throws ForbiddenException (defense-in-depth)', async () => {
			const service = makeService();

			await expect(
				service.createOne({ user: OTHER_USER, collection: 'directus_users', layout: 'tabular' })
			).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('createMany with any element having a user other than the caller throws ForbiddenException', async () => {
			const service = makeService();

			await expect(
				service.createMany([
					{ user: CALLER_USER, collection: 'directus_users' },
					{ user: OTHER_USER, collection: 'directus_users' },
				])
			).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('bug-exposing — non-admin omitted user on create (OR-merge widening defense)', () => {
		it('createOne without user throws InvalidPayloadException', async () => {
			const service = makeService();

			await expect(service.createOne({ collection: 'directus_users', layout: 'tabular' })).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('createMany with one element missing user throws InvalidPayloadException', async () => {
			const service = makeService();

			await expect(
				service.createMany([
					{ user: CALLER_USER, collection: 'directus_users' },
					{ collection: 'directus_users', layout: 'tabular' },
				])
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});
	});

	describe('regression — guard does not reject legitimate writes', () => {
		it('createOne with caller user is not rejected by the guard', async () => {
			const service = makeService();

			await expect(
				service.createOne({ user: CALLER_USER, collection: 'directus_users', layout: 'tabular' })
			).resolves.toBe(PRESET_ID);
		});

		it('createMany with all caller-user items is not rejected by the guard', async () => {
			const service = makeService();

			await expect(
				service.createMany([
					{ user: CALLER_USER, collection: 'directus_users' },
					{ user: CALLER_USER, collection: 'directus_users' },
				])
			).resolves.toEqual([PRESET_ID]);
		});

		it('updateOne with caller user is not rejected by the guard', async () => {
			const service = makeService();
			await expect(service.updateOne(PRESET_ID, { user: CALLER_USER })).resolves.toBe(PRESET_ID);
		});

		it('updateOne without user in payload is not rejected by the guard (non-user field update)', async () => {
			const service = makeService();
			await expect(service.updateOne(PRESET_ID, { layout: 'cards' })).resolves.toBe(PRESET_ID);
		});

		it('updateMany without user in payload is not rejected by the guard', async () => {
			const service = makeService();
			await expect(service.updateMany([PRESET_ID], { layout: 'cards' })).resolves.toEqual([PRESET_ID]);
		});

		it('updateBatch with all caller-user items is not rejected by the guard', async () => {
			const service = makeService();

			await expect(
				service.updateBatch([
					{ id: PRESET_ID, user: CALLER_USER },
					{ id: PRESET_ID, user: CALLER_USER },
				])
			).resolves.toEqual([PRESET_ID]);
		});
	});

	describe('regression — admin exemption', () => {
		it('admin createOne with any user is not rejected by the guard', async () => {
			const service = makeService({ admin: true });

			await expect(
				service.createOne({ user: OTHER_USER, collection: 'directus_users', layout: 'tabular' })
			).resolves.toBe(PRESET_ID);
		});

		it('admin createOne with no user field is not rejected by the guard', async () => {
			const service = makeService({ admin: true });

			await expect(service.createOne({ collection: 'directus_users', layout: 'tabular' })).resolves.toBe(PRESET_ID);
		});

		it('admin updateOne to any user is not rejected by the guard', async () => {
			const service = makeService({ admin: true });
			await expect(service.updateOne(PRESET_ID, { user: OTHER_USER })).resolves.toBe(PRESET_ID);
		});

		it('admin createMany with mixed users is not rejected by the guard', async () => {
			const service = makeService({ admin: true });

			await expect(
				service.createMany([
					{ user: CALLER_USER, collection: 'directus_users' },
					{ user: OTHER_USER, collection: 'directus_users' },
				])
			).resolves.toEqual([PRESET_ID]);
		});
	});

	describe('defensive boundaries', () => {
		it('null accountability rejects user-setting create', async () => {
			const service = new PresetsService({ knex: db, schema: testSchema, accountability: null });

			await expect(
				service.createOne({ user: OTHER_USER, collection: 'directus_users', layout: 'tabular' })
			).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('non-admin caller with null user rejects any user-setting create', async () => {
			const service = makeService({ user: null });

			await expect(
				service.createOne({ user: OTHER_USER, collection: 'directus_users', layout: 'tabular' })
			).rejects.toBeInstanceOf(ForbiddenException);
		});
	});
});
