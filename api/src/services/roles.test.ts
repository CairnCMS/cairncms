import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction, SpyInstance } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, InvalidPayloadException, UnprocessableEntityException } from '../exceptions/index.js';
import type { MutationOptions } from '../types/index.js';
import { getDatabaseClient } from '../database/index.js';
import {
	AuthorizationService,
	ItemsService,
	PermissionsService,
	PresetsService,
	RolesService,
	UsersService,
} from './index.js';

vi.mock('../../src/database/index', () => {
	return { __esModule: true, default: vi.fn(), getDatabaseClient: vi.fn().mockReturnValue('postgres') };
});

const testSchema = {
	collections: {
		directus_roles: {
			collection: 'directus_roles',
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
			},
		},
	},
	relations: [],
} as SchemaOverview;

describe('Integration Tests', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;
	let adminSnapshotRows: { id: unknown }[] = [];

	beforeAll(async () => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	beforeEach(() => {
		vi.mocked(getDatabaseClient).mockReturnValue('postgres');
		adminSnapshotRows = [];
		tracker.on.any(/set transaction isolation level/i).response([]);
		tracker.on.select(/select "id" from "directus_roles" where "admin_access"/).response(() => adminSnapshotRows);
		tracker.on.any('directus_roles').response({});

		tracker.on
			.select(/"directus_roles"."id" from "directus_roles" order by "directus_roles"."id" asc limit .*/)
			.response([]);
	});

	afterEach(() => {
		tracker.reset();
	});

	describe('Services / RolesService', () => {
		describe('updateOne', () => {
			let service: RolesService;
			let superUpdateOne: SpyInstance;
			const adminRoleId = 'cbfd1e77-b883-4090-93e4-5bcbfbd48aba';
			const userId1 = '07a5fee0-c168-49e2-8e33-4bae280e0c48';
			const userId2 = 'abedf9a4-6956-4a9c-8904-c1aa08a68173';

			beforeEach(() => {
				service = new RolesService({
					knex: db,
					schema: testSchema,
				});

				superUpdateOne = vi.spyOn(ItemsService.prototype, 'updateOne');
			});

			afterEach(() => {
				superUpdateOne.mockRestore();
			});

			describe('checkForOtherAdminUsers', () => {
				describe('on an admin role', () => {
					const admin_access = true;

					describe('with an array of user ids', () => {
						it('having an added user', async () => {
							const data: Record<string, any> = {
								users: [userId1, userId2],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed user', async () => {
							const data: Record<string, any> = {
								users: [userId1],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });

							tracker.on
								.select('select "id" from "directus_users" where "role" = ?')
								.responseOnce([{ id: userId1 }, { id: userId2 }]);

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed last user that is not the last admin of system', async () => {
							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed a last user that is the last admin of system', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});
					});

					describe('with an array of user objects', () => {
						it('having an added user', async () => {
							const data: Record<string, any> = {
								users: [{ id: userId1 }, { id: userId2 }],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed user', async () => {
							const data: Record<string, any> = {
								users: [{ id: userId1 }],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });

							tracker.on
								.select('select "id" from "directus_users" where "role" = ?')
								.responseOnce([{ id: userId1 }, { id: userId2 }]);

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed last user that is not the last admin of system', async () => {
							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed a last user that is the last admin of system', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});
					});

					describe('with an alterations object', () => {
						it('having a newly created user', async () => {
							const data: Record<string, any> = {
								users: {
									create: [{ name: 'New User' }],
									update: [],
									delete: [],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having an added user', async () => {
							const data: Record<string, any> = {
								users: {
									create: [],
									update: [{ role: adminRoleId, id: userId2 }],
									delete: [],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed user', async () => {
							const data: Record<string, any> = {
								users: {
									create: [],
									update: [],
									delete: [userId2],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });

							tracker.on
								.select('select "id" from "directus_users" where "role" = ?')
								.responseOnce([{ id: userId1 }, { id: userId2 }]);

							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed last user that is not the last admin of system', async () => {
							const data: Record<string, any> = {
								users: {
									create: [],
									update: [],
									delete: [userId1],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed a last user that is the last admin of system', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: {
									create: [],
									update: [],
									delete: [userId1],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});
					});
				});

				describe('on an non-admin role', () => {
					const admin_access = false;

					describe('with an array of user ids', () => {
						it('having an added user', async () => {
							const data: Record<string, any> = {
								users: [userId1, userId2],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having an added user that is the last admin', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: [userId1, userId2],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});

						it('having a removed user', async () => {
							const data: Record<string, any> = {
								users: [userId1],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });

							tracker.on
								.select('select "id" from "directus_users" where "role" = ?')
								.responseOnce([{ id: userId1 }, { id: userId2 }]);

							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed last user that is not the last admin of system', async () => {
							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed a last user that is the last admin of system', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});
					});

					describe('with an array of user objects', () => {
						it('having an added user', async () => {
							const data: Record<string, any> = {
								users: [{ id: userId1 }, { id: userId2 }],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having an added user that is the last admin', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: [{ id: userId1 }, { id: userId2 }],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});

						it('having a removed user', async () => {
							const data: Record<string, any> = {
								users: [{ id: userId1 }],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });

							tracker.on
								.select('select "id" from "directus_users" where "role" = ?')
								.responseOnce([{ id: userId1 }, { id: userId2 }]);

							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed last user that is not the last admin of system', async () => {
							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed a last user that is the last admin of system', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: [],
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});
					});

					describe('with an alterations object', () => {
						it('having a newly created user', async () => {
							const data: Record<string, any> = {
								users: {
									create: [{ name: 'New User' }],
									update: [],
									delete: [],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having an added user', async () => {
							const data: Record<string, any> = {
								users: {
									create: [],
									update: [{ role: adminRoleId, id: userId2 }],
									delete: [],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having an added user that is the last admin', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: {
									create: [],
									update: [{ role: adminRoleId, id: userId2 }],
									delete: [],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});

						it('having a removed user', async () => {
							const data: Record<string, any> = {
								users: {
									create: [],
									update: [],
									delete: [userId2],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });

							tracker.on
								.select('select "id" from "directus_users" where "role" = ?')
								.responseOnce([{ id: userId1 }, { id: userId2 }]);

							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed last user that is not the last admin of system', async () => {
							const data: Record<string, any> = {
								users: {
									create: [],
									update: [],
									delete: [userId1],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 1 });

							const result = await service.updateOne(adminRoleId, data);
							expect(result).toBe(adminRoleId);
							expect(superUpdateOne).toHaveBeenCalledOnce();
						});

						it('having a removed a last user that is the last admin of system', async () => {
							const service = new RolesService({
								knex: db,
								schema: testSchema,
								accountability: { role: 'test', admin: false },
							});

							const data: Record<string, any> = {
								users: {
									create: [],
									update: [],
									delete: [userId1],
								},
							};

							tracker.on.select('select "admin_access" from "directus_roles"').responseOnce({ admin_access });
							tracker.on.select('select "id" from "directus_users" where "role" = ?').responseOnce([{ id: userId1 }]);
							tracker.on.select('select count(*) as "count" from "directus_users"').responseOnce({ count: 0 });

							const promise = service.updateOne(adminRoleId, data);

							expect.assertions(5); // to ensure both assertions in the catch block are reached

							try {
								await promise;
							} catch (err: any) {
								expect(err.message).toBe(`You don't have permission to access this.`);
								expect(err).toBeInstanceOf(ForbiddenException);
							}

							expect(superUpdateOne).toHaveBeenCalled();

							expect(superUpdateOne.mock.lastCall![2].preMutationException.message).toBe(
								`You can't remove the last admin user from the admin role.`
							);

							expect(superUpdateOne.mock.lastCall![2].preMutationException).toBeInstanceOf(
								UnprocessableEntityException
							);
						});
					});
				});
			});
		});
	});

	describe('Services / Roles', () => {
		let service: RolesService;
		let checkForOtherAdminUsersSpy: SpyInstance;

		beforeEach(() => {
			service = new RolesService({
				knex: db,
				schema: {
					collections: {
						directus_roles: {
							collection: 'directus_roles',
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
							},
						},
					},
					relations: [],
				},
			});

			vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValueOnce([]);
			vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValueOnce([]);
			vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValueOnce([]);
			vi.spyOn(UsersService.prototype, 'deleteByQuery').mockResolvedValueOnce([]);

			// "as any" is needed since this is a private method
			checkForOtherAdminUsersSpy = vi
				.spyOn(RolesService.prototype as any, 'checkForOtherAdminUsers')
				.mockResolvedValueOnce(true);
		});

		afterEach(() => {
			checkForOtherAdminUsersSpy.mockRestore();
		});

		describe('createOne', () => {
			it('should auto-generate key from name', async () => {
				tracker.on.select('select "key" from "directus_roles"').responseOnce([]);

				const createOneSpy = vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValueOnce('uuid');
				await service.createOne({ name: 'Supreme Editor' });

				expect(createOneSpy).toHaveBeenCalledWith(
					expect.objectContaining({ name: 'Supreme Editor', key: 'supreme_editor' }),
					undefined
				);

				createOneSpy.mockRestore();
			});

			it('should reject when neither name nor key is provided', async () => {
				await expect(service.createOne({})).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('should reject invalid caller-supplied key', async () => {
				await expect(service.createOne({ key: 'Bad Key', name: 'Test' })).rejects.toBeInstanceOf(
					InvalidPayloadException
				);
			});
		});

		describe('createMany', () => {
			it('should generate unique keys for duplicate names in batch', async () => {
				tracker.on.select('select "key" from "directus_roles"').responseOnce([]);

				const createManySpy = vi.spyOn(ItemsService.prototype, 'createMany').mockResolvedValueOnce(['uuid1', 'uuid2']);
				await service.createMany([{ name: 'Editor' }, { name: 'Editor' }]);

				expect(createManySpy).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({ name: 'Editor', key: 'editor' }),
						expect.objectContaining({ name: 'Editor', key: 'editor_2' }),
					]),
					undefined
				);

				createManySpy.mockRestore();
			});

			it('should reject duplicate caller-supplied keys in batch', async () => {
				tracker.on.select('select "key" from "directus_roles"').responseOnce([]);

				await expect(
					service.createMany([
						{ key: 'editor', name: 'A' },
						{ key: 'editor', name: 'B' },
					])
				).rejects.toBeInstanceOf(InvalidPayloadException);
			});
		});

		describe('updateOne', () => {
			it('should reject changing key to a different value', async () => {
				tracker.on.select('select "key" from "directus_roles" where "id" = ?').responseOnce({ key: 'editor' });

				await expect(service.updateOne(1, { key: 'different_key' })).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('should allow updates with the same key (idempotent save)', async () => {
				tracker.on.select('select "key" from "directus_roles" where "id" = ?').responseOnce({ key: 'editor' });

				await expect(service.updateOne(1, { key: 'editor', name: 'New Name' })).resolves.not.toThrow();
			});
		});

		describe('upsertMany', () => {
			beforeEach(() => {
				tracker.on.select(/select "key" from "directus_roles"$/).response([{ key: 'editor' }]);
			});

			it('creates a missing role with a generated key through the shared deferred options', async () => {
				const createOne = vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValueOnce(7);

				await expect(service.upsertMany([{ name: 'Supreme Editor' }])).resolves.toEqual([7]);

				expect(createOne).toHaveBeenCalledWith(
					expect.objectContaining({ name: 'Supreme Editor', key: 'supreme_editor' }),
					expect.objectContaining({ autoPurgeCache: false, autoPurgeSystemCache: false })
				);

				createOne.mockRestore();
			});

			it('rejects an invalid, reserved, or already-used caller-supplied key on create', async () => {
				for (const key of ['Bad Key', 'public', 'editor']) {
					await expect(service.upsertMany([{ key, name: 'Test' }])).rejects.toBeInstanceOf(InvalidPayloadException);
				}
			});

			it('rejects a missing name and key on create', async () => {
				await expect(service.upsertMany([{ description: 'x' }])).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('rejects changing an existing role key on update', async () => {
				tracker.on.select('select "key" from "directus_roles" where "id" = ?').responseOnce({ key: 'editor' });

				await expect(service.upsertMany([{ id: 1, key: 'different_key' }])).rejects.toBeInstanceOf(
					InvalidPayloadException
				);
			});

			it.each(['admin_access', 'app_access', 'enforce_tfa', 'ip_access', 'users'])(
				'rejects the protected field %s on the sentinel role',
				async (field) => {
					const schema = JSON.parse(JSON.stringify(service.schema)) as typeof service.schema;
					schema.collections['directus_roles']!.fields['id']!.type = 'uuid';
					schema.collections['directus_roles']!.fields['id']!.dbType = 'uuid';
					const sentinelService = new RolesService({ knex: db, schema });
					const updateOne = vi.spyOn(ItemsService.prototype, 'updateOne');

					await expect(
						sentinelService.upsertMany([{ id: '00000000-0000-0000-0000-000000000000', [field]: true }])
					).rejects.toBeInstanceOf(InvalidPayloadException);

					expect(updateOne).not.toHaveBeenCalled();
					updateOne.mockRestore();
				}
			);

			it('allows a display-only field on the sentinel role', async () => {
				const schema = JSON.parse(JSON.stringify(service.schema)) as typeof service.schema;
				schema.collections['directus_roles']!.fields['id']!.type = 'uuid';
				schema.collections['directus_roles']!.fields['id']!.dbType = 'uuid';
				const sentinelService = new RolesService({ knex: db, schema });
				const updateOne = vi.spyOn(ItemsService.prototype, 'updateOne').mockResolvedValueOnce('public');

				await expect(
					sentinelService.upsertMany([{ id: '00000000-0000-0000-0000-000000000000', name: 'Public' }])
				).resolves.toEqual(['public']);

				updateOne.mockRestore();
			});
		});

		describe('sentinel role guards', () => {
			// Real directus_roles.id is a UUID; the shared service above uses an integer
			// schema for test-simplicity. These tests need UUID-typed keys so that
			// validateKeys() doesn't reject the sentinel UUID before our guards can fire.
			let uuidService: RolesService;

			beforeEach(() => {
				uuidService = new RolesService({
					knex: db,
					schema: {
						collections: {
							directus_roles: {
								collection: 'directus_roles',
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
								},
							},
						},
						relations: [],
					},
				});
			});

			it('should reject deletion of the sentinel role via deleteOne', async () => {
				await expect(uuidService.deleteOne('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
					InvalidPayloadException
				);
			});

			it('should reject batches that include the sentinel role via deleteMany', async () => {
				const uuid1 = '11111111-1111-1111-1111-111111111111';
				const uuid2 = '22222222-2222-2222-2222-222222222222';

				await expect(
					uuidService.deleteMany([uuid1, '00000000-0000-0000-0000-000000000000', uuid2])
				).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('should reject deleteByQuery resolving to sentinel', async () => {
				vi.spyOn(ItemsService.prototype, 'getKeysByQuery').mockResolvedValueOnce([
					'00000000-0000-0000-0000-000000000000',
				]);

				await expect(uuidService.deleteByQuery({})).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('should reject forbidden field changes on the sentinel role', async () => {
				for (const field of ['admin_access', 'app_access', 'enforce_tfa', 'ip_access', 'users']) {
					await expect(
						uuidService.updateOne('00000000-0000-0000-0000-000000000000', { [field]: true })
					).rejects.toBeInstanceOf(InvalidPayloadException);
				}
			});

			it('should allow display-only field changes on the sentinel role', async () => {
				for (const field of ['name', 'icon', 'description']) {
					await expect(
						uuidService.updateOne('00000000-0000-0000-0000-000000000000', { [field]: 'x' })
					).resolves.not.toThrow();
				}
			});

			it('should allow idempotent key save on the sentinel role', async () => {
				tracker.on.select('select "key" from "directus_roles" where "id" = ?').responseOnce({ key: 'public' });

				await expect(
					uuidService.updateOne('00000000-0000-0000-0000-000000000000', {
						key: 'public',
						name: 'Public',
					})
				).resolves.not.toThrow();
			});

			it('should allow idempotent key save via updateMany on sentinel', async () => {
				tracker.on.select('select "key" from "directus_roles" where "id" = ?').responseOnce({ key: 'public' });

				await expect(
					uuidService.updateMany(['00000000-0000-0000-0000-000000000000'], {
						key: 'public',
						name: 'Public',
					})
				).resolves.not.toThrow();
			});

			it('should reject forbidden field on sentinel via updateMany', async () => {
				await expect(
					uuidService.updateMany(['00000000-0000-0000-0000-000000000000'], { admin_access: false })
				).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('should allow idempotent key save via updateBatch on sentinel', async () => {
				tracker.on.select('select "key" from "directus_roles" where "id" = ?').responseOnce({ key: 'public' });

				await expect(
					uuidService.updateBatch([{ id: '00000000-0000-0000-0000-000000000000', key: 'public', name: 'Public' }])
				).resolves.not.toThrow();
			});

			it('should reject forbidden field on sentinel via updateBatch', async () => {
				await expect(
					uuidService.updateBatch([{ id: '00000000-0000-0000-0000-000000000000', users: [1] }])
				).rejects.toBeInstanceOf(InvalidPayloadException);
			});
		});
	});

	describe('Services / Roles delete option forwarding', () => {
		const rolesSchema = {
			collections: {
				directus_roles: {
					collection: 'directus_roles',
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
					},
				},
			},
			relations: [],
		} as SchemaOverview;

		const roleFilter = { filter: { role: { _in: [1] } } };

		let service: RolesService;

		beforeEach(() => {
			service = new RolesService({ knex: db, schema: rolesSchema });
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		function buildOptions(): MutationOptions {
			return {
				onRevisionCreate: vi.fn(),
				autoPurgeCache: false,
				autoPurgeSystemCache: false,
				emitEvents: false,
				bypassEmitAction: vi.fn(),
				bypassLimits: false,
				mutationTracker: { trackMutations: vi.fn(), getCount: vi.fn(() => 0) },
			};
		}

		describe('deleteMany', () => {
			it('forwards options through the cascade, forcing bypassLimits only on the dependent mutations', async () => {
				adminSnapshotRows = [{ id: 1 }, { id: 2 }];
				const permissions = vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const presets = vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const users = vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValue([]);
				const roleDeletion = vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await service.deleteMany([1], buildOptions());

				const dependent = expect.objectContaining({
					bypassLimits: true,
					autoPurgeCache: false,
					autoPurgeSystemCache: false,
				});

				expect(permissions).toHaveBeenCalledTimes(1);
				expect(permissions).toHaveBeenCalledWith(roleFilter, dependent);
				expect(presets).toHaveBeenCalledTimes(1);
				expect(presets).toHaveBeenCalledWith(roleFilter, dependent);
				expect(users).toHaveBeenCalledTimes(1);
				expect(users).toHaveBeenCalledWith(roleFilter, { status: 'suspended', role: null }, dependent);
				expect(roleDeletion).toHaveBeenCalledTimes(1);
				expect(roleDeletion.mock.calls[0]![1]!.bypassLimits).toBe(false);
			});
		});

		describe('deleteOne', () => {
			it('forwards the key and options to deleteMany', async () => {
				const deleteMany = vi.spyOn(RolesService.prototype, 'deleteMany').mockResolvedValue([1]);

				const opts = buildOptions();
				await service.deleteOne(1, opts);

				expect(deleteMany).toHaveBeenCalledTimes(1);
				expect(deleteMany).toHaveBeenCalledWith([1], opts);
			});
		});

		describe('deleteByQuery', () => {
			it('forwards resolved keys and options through the role-deletion cascade', async () => {
				vi.spyOn(ItemsService.prototype, 'getKeysByQuery').mockResolvedValueOnce([1]);
				adminSnapshotRows = [{ id: 1 }, { id: 2 }];
				const permissions = vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const presets = vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const users = vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValue([]);
				const roleDeletion = vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await service.deleteByQuery({ filter: { name: { _eq: 'obsolete' } } }, buildOptions());

				const dependent = expect.objectContaining({ bypassLimits: true });
				expect(permissions).toHaveBeenCalledWith(roleFilter, dependent);
				expect(presets).toHaveBeenCalledWith(roleFilter, dependent);
				expect(users).toHaveBeenCalledWith(roleFilter, { status: 'suspended', role: null }, dependent);
				expect(roleDeletion).toHaveBeenCalledWith([1], expect.objectContaining({ bypassLimits: false }));
			});
		});

		describe('last-administrator guard', () => {
			it('rejects deleting the last administrator role before entering the cascade', async () => {
				adminSnapshotRows = [{ id: 1 }];
				const permissions = vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const presets = vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const users = vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValue([]);
				const roleDeletion = vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await expect(service.deleteMany([1], buildOptions())).rejects.toBeInstanceOf(UnprocessableEntityException);

				expect(permissions).not.toHaveBeenCalled();
				expect(presets).not.toHaveBeenCalled();
				expect(users).not.toHaveBeenCalled();
				expect(roleDeletion).not.toHaveBeenCalled();
			});

			it('allows deleting an administrator role while another remains', async () => {
				adminSnapshotRows = [{ id: 1 }, { id: 2 }];
				vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValue([]);
				vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await expect(service.deleteMany([1], buildOptions())).resolves.toEqual([1]);
			});
		});

		describe('deleteMany authorization ordering', () => {
			const nonAdmin = { admin: false, app: true, role: 'r', user: 'u', permissions: [] } as never;

			function unauthorizedService(): RolesService {
				return new RolesService({ knex: db, schema: service.schema, accountability: nonAdmin });
			}

			function sentinelCapableService(): RolesService {
				const schema = JSON.parse(JSON.stringify(service.schema)) as typeof service.schema;
				schema.collections['directus_roles']!.fields['id']!.type = 'uuid';
				schema.collections['directus_roles']!.fields['id']!.dbType = 'uuid';
				return new RolesService({ knex: db, schema, accountability: nonAdmin });
			}

			it('refuses an unauthorized deletion before reading the administrator set or starting the cascade', async () => {
				adminSnapshotRows = [{ id: 1 }];

				const checkAccess = vi
					.spyOn(AuthorizationService.prototype, 'checkAccess')
					.mockRejectedValue(new ForbiddenException());

				const permissions = vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				const roleDeletion = vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await expect(unauthorizedService().deleteMany([1], buildOptions())).rejects.toBeInstanceOf(ForbiddenException);

				expect(checkAccess).toHaveBeenCalledWith('delete', 'directus_roles', [1]);
				expect(tracker.history.select.some((query) => /admin_access/.test(query.sql))).toBe(false);
				expect(permissions).not.toHaveBeenCalled();
				expect(roleDeletion).not.toHaveBeenCalled();
			});

			it('conceals the sentinel refusal from an unauthorized caller', async () => {
				vi.spyOn(AuthorizationService.prototype, 'checkAccess').mockRejectedValue(new ForbiddenException());

				await expect(
					sentinelCapableService().deleteMany(['00000000-0000-0000-0000-000000000000'], buildOptions())
				).rejects.toBeInstanceOf(ForbiddenException);
			});

			it('still refuses the sentinel for an authorized caller', async () => {
				vi.spyOn(AuthorizationService.prototype, 'checkAccess').mockResolvedValue(undefined);

				await expect(
					sentinelCapableService().deleteMany(['00000000-0000-0000-0000-000000000000'], buildOptions())
				).rejects.toBeInstanceOf(InvalidPayloadException);
			});

			it('lets an authorized caller reach the continuity check', async () => {
				adminSnapshotRows = [{ id: 1 }];
				vi.spyOn(AuthorizationService.prototype, 'checkAccess').mockResolvedValue(undefined);
				vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValue([]);
				vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await expect(unauthorizedService().deleteMany([1], buildOptions())).rejects.toBeInstanceOf(
					UnprocessableEntityException
				);
			});

			it('skips the authorization check for a service without accountability', async () => {
				adminSnapshotRows = [{ id: 1 }, { id: 2 }];
				const checkAccess = vi.spyOn(AuthorizationService.prototype, 'checkAccess');
				vi.spyOn(PermissionsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				vi.spyOn(PresetsService.prototype, 'deleteByQuery').mockResolvedValue([]);
				vi.spyOn(UsersService.prototype, 'updateByQuery').mockResolvedValue([]);
				vi.spyOn(ItemsService.prototype, 'deleteMany').mockResolvedValue([1]);

				await expect(service.deleteMany([1], buildOptions())).resolves.toEqual([1]);
				expect(checkAccess).not.toHaveBeenCalled();
			});
		});
	});

	describe('Services / Roles administrator continuity on update', () => {
		const continuitySchema = {
			collections: {
				directus_roles: {
					collection: 'directus_roles',
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
						admin_access: {
							field: 'admin_access',
							defaultValue: false,
							nullable: false,
							generated: false,
							type: 'boolean',
							dbType: 'boolean',
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

		let service: RolesService;

		beforeEach(() => {
			service = new RolesService({ knex: db, schema: continuitySchema });
			tracker.on.select(/select "key" from "directus_roles"$/).response([]);
		});

		it('allows demoting an administrator while another remains', async () => {
			adminSnapshotRows = [{ id: 1 }, { id: 2 }];
			await expect(service.updateMany([1], { admin_access: false })).resolves.toEqual([1]);
		});

		it('rejects demoting the last administrator role', async () => {
			adminSnapshotRows = [{ id: 1 }];

			await expect(service.updateMany([1], { admin_access: false })).rejects.toBeInstanceOf(
				UnprocessableEntityException
			);
		});

		it('rejects a batch that demotes the last administrator even when it promotes another', async () => {
			adminSnapshotRows = [{ id: 2 }];

			await expect(
				service.updateBatch([
					{ id: 1, admin_access: true },
					{ id: 2, admin_access: false },
				])
			).rejects.toBeInstanceOf(UnprocessableEntityException);
		});

		it('allows a batch that demotes one administrator while another stays an administrator', async () => {
			adminSnapshotRows = [{ id: 1 }, { id: 2 }];

			await expect(
				service.updateBatch([
					{ id: 1, admin_access: false },
					{ id: 2, admin_access: true },
				])
			).resolves.toEqual([1, 2]);
		});

		function rolesExist(...ids: number[]): void {
			tracker.on
				.select(/select "id" from "directus_roles" where "id" = /)
				.response((query) => (ids.includes(Number(query.bindings[0])) ? [{ id: query.bindings[0] }] : []));
		}

		it('reaches continuity enforcement through upsertMany for an existing administrator role', async () => {
			adminSnapshotRows = [{ id: 1 }];
			rolesExist(1);
			const createOne = vi.spyOn(ItemsService.prototype, 'createOne');

			await expect(service.upsertMany([{ id: 1, admin_access: false }])).rejects.toBeInstanceOf(
				UnprocessableEntityException
			);

			expect(createOne).not.toHaveBeenCalled();

			createOne.mockRestore();
		});

		it('does not credit a promotion made earlier in the same upsertMany call', async () => {
			adminSnapshotRows = [{ id: 1 }];
			rolesExist(1, 2);

			await expect(
				service.upsertMany([
					{ id: 2, admin_access: true },
					{ id: 1, admin_access: false },
				])
			).rejects.toBeInstanceOf(UnprocessableEntityException);
		});

		it('creates and updates through upsertMany under one deferred lifecycle', async () => {
			adminSnapshotRows = [{ id: 1 }, { id: 2 }];
			rolesExist(1);
			const createOne = vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValueOnce(9);

			await expect(service.upsertMany([{ name: 'Fresh' }, { id: 1, admin_access: false }])).resolves.toEqual([9, 1]);

			expect(createOne).toHaveBeenCalledWith(
				expect.objectContaining({ key: 'fresh' }),
				expect.objectContaining({ autoPurgeCache: false, autoPurgeSystemCache: false })
			);

			createOne.mockRestore();
		});

		it('does not mutate the caller-supplied options object', async () => {
			adminSnapshotRows = [{ id: 1 }, { id: 2 }];
			const opts: MutationOptions = {};
			await service.updateMany([1], { admin_access: false }, opts);
			expect(opts).toEqual({});
		});

		it('does not mutate frozen caller-supplied options through upsertMany', async () => {
			adminSnapshotRows = [{ id: 1 }, { id: 2 }];
			rolesExist(1);
			const opts = Object.freeze({}) as MutationOptions;

			await expect(service.upsertMany([{ id: 1, admin_access: false }], opts)).resolves.toEqual([1]);
			expect(opts).toEqual({});
		});
	});
});
