import request from 'supertest';
import { randomUUID } from 'crypto';
import config, { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { sleep } from '@utils/sleep';
import knex, { type Knex } from 'knex';

const DRIVER_LEAK = /40001|40P01|1213|1205|deadlock|serialize|SQLITE_BUSY|ER_LOCK/i;

describe('Roles administrator continuity', () => {
	const databases = new Map<string, Knex>();
	const token = common.USER.ADMIN!.TOKEN;

	beforeAll(() => {
		for (const vendor of vendors) databases.set(vendor, knex(config.knexConfig[vendor]!));
	});

	afterAll(async () => {
		for (const [, db] of databases) await db.destroy();
	});

	async function createAdminRole(vendor: string, name: string): Promise<{ id: string }> {
		const response = await request(getUrl(vendor))
			.post('/roles')
			.set('Authorization', `Bearer ${token}`)
			.send({ name, admin_access: true });

		expect(response.statusCode).toBe(200);
		expect(response.body.data.id).toBeDefined();
		return { id: response.body.data.id };
	}

	describe('two concurrent PostgreSQL administrator demotions resolve to one success and one conflict', () => {
		it.each(vendors.filter((vendor) => vendor === 'postgres'))('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const marker = randomUUID();
			const committedKey = `roles-continuity-barrier/committed/${marker}`;

			let roleX: { id: string } | undefined;
			let roleY: { id: string } | undefined;

			try {
				roleX = await createAdminRole(vendor, 'race-admin-x');
				roleY = await createAdminRole(vendor, 'race-admin-y');

				const [responseX, responseY] = await Promise.all([
					request(getUrl(vendor))
						.patch(`/roles/${roleX.id}`)
						.set('Authorization', `Bearer ${token}`)
						.send({ admin_access: false, _raceBarrier: marker }),
					request(getUrl(vendor))
						.patch(`/roles/${roleY.id}`)
						.set('Authorization', `Bearer ${token}`)
						.send({ admin_access: false, _raceBarrier: marker }),
				]);

				expect([responseX.statusCode, responseY.statusCode].sort()).toEqual([200, 409]);

				const conflict = [responseX, responseY].find((response) => response.statusCode === 409)!;
				expect(conflict.body.errors[0].extensions.code).toBe('CONCURRENCY_CONFLICT');
				expect(JSON.stringify(conflict.body)).not.toMatch(DRIVER_LEAK);

				const committedRoleId = responseX.statusCode === 200 ? roleX.id : roleY.id;
				const conflictRoleId = responseX.statusCode === 200 ? roleY.id : roleX.id;

				const rows = await db('directus_roles').whereIn('id', [roleX.id, roleY.id]).select('id', 'admin_access');
				const stillAdmin = rows.filter((row) => row.admin_access === true || row.admin_access === 1);
				expect(stillAdmin.map((row) => row.id)).toEqual([conflictRoleId]);

				// Action events are not awaited, so allow the marker count to settle.
				let committed: Array<{ value: string }> = [];

				for (let attempt = 0; attempt < 50; attempt++) {
					committed = await db('tests_extensions_log').where({ key: committedKey }).select('value');
					if (committed.length >= 1) break;
					await sleep(100);
				}

				expect(committed).toHaveLength(1);
				expect(JSON.parse(committed[0]!.value)).toContain(committedRoleId);

				await sleep(1000);
				expect(await db('tests_extensions_log').where({ key: committedKey }).select('id')).toHaveLength(1);
			} finally {
				const created = [roleX, roleY].filter((role): role is { id: string } => role !== undefined);

				// Delete the raced roles one at a time. One is still an administrator, so concurrent
				// deletes would each open a serializable transaction and collide on the admin set.
				for (const role of created) {
					await request(getUrl(vendor))
						.delete(`/roles/${role.id}`)
						.set('Authorization', `Bearer ${token}`)
						.catch(() => undefined);
				}

				await db('tests_extensions_log').where({ key: committedKey }).delete();

				if (created.length > 0) {
					expect(
						await db('directus_roles')
							.whereIn(
								'id',
								created.map((role) => role.id)
							)
							.select('id')
					).toHaveLength(0);
				}

				expect(await db('tests_extensions_log').where({ key: committedKey }).select('id')).toHaveLength(0);
			}
		});
	});

	describe('a filter-injected demotion of the last administrator is caught by the post-typecast seam', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const adminUser = await db('directus_users').where({ email: common.USER.ADMIN!.EMAIL }).first();
			expect(adminUser).toBeTruthy();

			const soleAdminId = adminUser.role;
			const before = await db('directus_roles').where({ id: soleAdminId }).first();
			expect(before).toBeTruthy();

			let others: Array<{ id: string }> = [];

			try {
				others = (await db('directus_roles').where({ admin_access: true }).select('id')).filter(
					(role) => role.id !== soleAdminId
				);

				await db('directus_roles')
					.whereIn(
						'id',
						others.map((role) => role.id)
					)
					.update({ admin_access: false });

				const response = await request(getUrl(vendor))
					.patch(`/roles/${soleAdminId}`)
					.set('Authorization', `Bearer ${token}`)
					.send({ name: 'renamed-but-injected', _injectDemotion: true });

				expect(response.statusCode).toBe(422);
				expect(response.body.errors[0].extensions.code).toBe('UNPROCESSABLE_ENTITY');
				expect(response.body.errors[0].message).toBe(`You can't delete the last admin role.`);

				expect(await db('directus_roles').where({ id: soleAdminId }).first()).toEqual(before);
			} finally {
				await db('directus_roles')
					.whereIn(
						'id',
						others.map((role) => role.id)
					)
					.update({ admin_access: true });
			}
		});
	});

	describe('an unauthorized role deletion is refused before any sentinel or continuity inspection', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const adminUser = await db('directus_users').where({ email: common.USER.ADMIN!.EMAIL }).first();
			const appUser = await db('directus_users').where({ email: common.USER.APP_ACCESS!.EMAIL }).first();
			const publicRole = await db('directus_roles').where({ key: 'public' }).first();

			expect(adminUser).toBeTruthy();
			expect(appUser).toBeTruthy();
			expect(publicRole).toBeTruthy();

			const before = await db('directus_roles').select('id', 'admin_access').orderBy('id');
			const targets = [adminUser.role, appUser.role, publicRole.id, randomUUID()];
			const bodies = new Set<string>();

			for (const target of targets) {
				for (const bearer of [common.USER.APP_ACCESS!.TOKEN, undefined]) {
					const req = request(getUrl(vendor)).delete(`/roles/${target}`);
					if (bearer) req.set('Authorization', `Bearer ${bearer}`);

					const response = await req;

					expect(response.statusCode).toBe(403);
					expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
					bodies.add(JSON.stringify(response.body));
				}
			}

			expect(bodies.size).toBe(1);
			expect(await db('directus_roles').select('id', 'admin_access').orderBy('id')).toEqual(before);
		});
	});
});
