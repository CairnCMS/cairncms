import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { MockClient, createTracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { AuthorizationService } from './authorization.js';
import { ItemsService } from './items.js';
import { SharesService } from './shares.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

const testSchema = {
	collections: {
		directus_shares: {
			collection: 'directus_shares',
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
				item: {
					field: 'item',
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
				name: {
					field: 'name',
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

const CALLER_ROLE = '11111111-1111-1111-1111-111111111111';
const OTHER_ROLE = '22222222-2222-2222-2222-222222222222';
const SHARE_ID = '33333333-3333-3333-3333-333333333333';

describe('SharesService — role validation (GHSA-pmf4-v838-29hg)', () => {
	let db: MockedFunction<Knex>;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		createTracker(db);
	});

	beforeEach(() => {
		vi.clearAllMocks();

		vi.spyOn(AuthorizationService.prototype, 'checkAccess').mockResolvedValue(undefined as any);
		vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue(SHARE_ID);
		vi.spyOn(ItemsService.prototype, 'createMany').mockResolvedValue([SHARE_ID]);
		vi.spyOn(ItemsService.prototype, 'updateOne').mockResolvedValue(SHARE_ID);
		vi.spyOn(ItemsService.prototype, 'updateMany').mockResolvedValue([SHARE_ID]);
		vi.spyOn(ItemsService.prototype, 'updateBatch').mockResolvedValue([SHARE_ID]);
	});

	function makeService(overrides: Partial<Accountability> = {}): SharesService {
		const accountability: Accountability = {
			user: 'user-uuid',
			role: CALLER_ROLE,
			admin: false,
			app: true,
			ip: '127.0.0.1',
			...overrides,
		};

		return new SharesService({ knex: db, schema: testSchema, accountability });
	}

	const validCreatePayload = (role: string | null | undefined = CALLER_ROLE) => ({
		collection: 'directus_users',
		item: 'item-uuid',
		role,
		password: 'x',
		name: 'test-share',
	});

	describe('bug-exposing — non-admin escalation attempts', () => {
		it('createOne with a role other than the caller throws ForbiddenException', async () => {
			const service = makeService();
			await expect(service.createOne(validCreatePayload(OTHER_ROLE))).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('createMany with any element having a role other than the caller throws ForbiddenException', async () => {
			const service = makeService();

			await expect(
				service.createMany([validCreatePayload(CALLER_ROLE), validCreatePayload(OTHER_ROLE)])
			).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('updateOne with a role other than the caller throws ForbiddenException', async () => {
			const service = makeService();
			await expect(service.updateOne(SHARE_ID, { role: OTHER_ROLE })).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('updateMany with a role other than the caller throws ForbiddenException', async () => {
			const service = makeService();
			await expect(service.updateMany([SHARE_ID], { role: OTHER_ROLE })).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('updateBatch with any element having a role other than the caller throws ForbiddenException', async () => {
			const service = makeService();

			await expect(
				service.updateBatch([
					{ id: SHARE_ID, role: CALLER_ROLE },
					{ id: SHARE_ID, role: OTHER_ROLE },
				])
			).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('bug-exposing — non-admin omitted role on create', () => {
		it('createOne without role throws InvalidPayloadException', async () => {
			const service = makeService();

			await expect(
				service.createOne({ collection: 'directus_users', item: 'item-uuid', password: 'x', name: 'no-role' })
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('createMany with one element missing role throws InvalidPayloadException', async () => {
			const service = makeService();

			await expect(
				service.createMany([
					validCreatePayload(CALLER_ROLE),
					{ collection: 'directus_users', item: 'item-uuid', password: 'x', name: 'no-role' },
				])
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});
	});

	describe('regression — non-admin legitimate writes', () => {
		it('createOne with caller role is accepted', async () => {
			const service = makeService();
			await expect(service.createOne(validCreatePayload(CALLER_ROLE))).resolves.toBe(SHARE_ID);
		});

		it('createMany with all caller-role items is accepted', async () => {
			const service = makeService();

			await expect(
				service.createMany([validCreatePayload(CALLER_ROLE), validCreatePayload(CALLER_ROLE)])
			).resolves.toEqual([SHARE_ID]);
		});

		it('updateOne with caller role is accepted', async () => {
			const service = makeService();
			await expect(service.updateOne(SHARE_ID, { role: CALLER_ROLE })).resolves.toBe(SHARE_ID);
		});

		it('updateOne without role in payload is accepted (non-role field update)', async () => {
			const service = makeService();
			await expect(service.updateOne(SHARE_ID, { name: 'renamed' })).resolves.toBe(SHARE_ID);
		});

		it('updateMany without role in payload is accepted', async () => {
			const service = makeService();
			await expect(service.updateMany([SHARE_ID], { name: 'renamed' })).resolves.toEqual([SHARE_ID]);
		});

		it('updateBatch with all caller-role items is accepted', async () => {
			const service = makeService();

			await expect(
				service.updateBatch([
					{ id: SHARE_ID, role: CALLER_ROLE },
					{ id: SHARE_ID, role: CALLER_ROLE },
				])
			).resolves.toEqual([SHARE_ID]);
		});
	});

	describe('regression — admin exemption', () => {
		it('admin createOne with any role is accepted', async () => {
			const service = makeService({ admin: true });
			await expect(service.createOne(validCreatePayload(OTHER_ROLE))).resolves.toBe(SHARE_ID);
		});

		it('admin createOne without role is accepted (omitted-role preserves pre-fix admin behavior)', async () => {
			const service = makeService({ admin: true });

			await expect(
				service.createOne({ collection: 'directus_users', item: 'item-uuid', password: 'x', name: 'admin-no-role' })
			).resolves.toBe(SHARE_ID);
		});

		it('admin updateOne to any role is accepted', async () => {
			const service = makeService({ admin: true });
			await expect(service.updateOne(SHARE_ID, { role: OTHER_ROLE })).resolves.toBe(SHARE_ID);
		});

		it('admin createMany with mixed roles is accepted', async () => {
			const service = makeService({ admin: true });

			await expect(
				service.createMany([validCreatePayload(CALLER_ROLE), validCreatePayload(OTHER_ROLE)])
			).resolves.toEqual([SHARE_ID]);
		});
	});

	describe('batch-create share-access check (closes a pre-existing batch-path bypass)', () => {
		it('createMany invokes checkAccess once per item with the share action and that item collection/item', async () => {
			const service = makeService();

			const checkAccessSpy = vi.spyOn(AuthorizationService.prototype, 'checkAccess');

			await service.createMany([
				{ ...validCreatePayload(CALLER_ROLE), collection: 'notes', item: 'note-uuid-1' },
				{ ...validCreatePayload(CALLER_ROLE), collection: 'notes', item: 'note-uuid-2' },
			]);

			expect(checkAccessSpy).toHaveBeenCalledTimes(2);
			expect(checkAccessSpy).toHaveBeenNthCalledWith(1, 'share', 'notes', 'note-uuid-1');
			expect(checkAccessSpy).toHaveBeenNthCalledWith(2, 'share', 'notes', 'note-uuid-2');
		});

		it('createMany rejects when checkAccess throws for any item', async () => {
			const service = makeService();

			vi.spyOn(AuthorizationService.prototype, 'checkAccess').mockImplementation(async (_action, _collection, item) => {
				if (item === 'note-uuid-2') throw new ForbiddenException();
			});

			await expect(
				service.createMany([
					{ ...validCreatePayload(CALLER_ROLE), collection: 'notes', item: 'note-uuid-1' },
					{ ...validCreatePayload(CALLER_ROLE), collection: 'notes', item: 'note-uuid-2' },
				])
			).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('defensive boundaries', () => {
		it('null accountability rejects role-setting create', async () => {
			const service = new SharesService({ knex: db, schema: testSchema, accountability: null });
			await expect(service.createOne(validCreatePayload(OTHER_ROLE))).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('non-admin caller with null role rejects any role-setting create', async () => {
			const service = makeService({ role: null });

			await expect(service.createOne(validCreatePayload(OTHER_ROLE))).rejects.toBeInstanceOf(ForbiddenException);
		});
	});
});
