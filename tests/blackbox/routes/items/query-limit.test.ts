import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { requestGraphQL } from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import type { PermissionsAction } from '@cairncms/types';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';

const adminToken = common.USER.ADMIN.TOKEN;
const parentCollection = 'test_items_query_limit_parent';
const childCollection = 'test_items_query_limit_child';
const maxLimit = 10;
const parentCount = 15;
const childCount = 15;
const permsCollection = 'test_items_query_limit_perms';
const permsRoleName = 'query_limit_perms_role';
const permsUserToken = 'QueryLimitPermsToken';
const permsUserEmail = 'query-limit-perms@example.com';
const permsCount = maxLimit + 1;
const permissionActions = ['read', 'create', 'update', 'delete'] as const satisfies readonly PermissionsAction[];

const permissionTargets = [parentCollection, childCollection, permsCollection]
	.flatMap((collection) => permissionActions.map((action) => ({ collection, action })))
	.slice(0, permsCount);

type CleanupResult = { ok: true } | { ok: false; reason: string };

function terminate(instance: ChildProcess | undefined): Promise<CleanupResult> {
	return new Promise<CleanupResult>((resolve) => {
		if (!instance || instance.exitCode !== null || instance.signalCode !== null) {
			resolve({ ok: true });
			return;
		}

		let settled = false;

		const settle = (result: CleanupResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(forceTimer);
			clearTimeout(hardTimer);
			resolve(result);
		};

		const forceTimer = setTimeout(() => instance.kill('SIGKILL'), 5000);
		const hardTimer = setTimeout(() => settle({ ok: false, reason: 'did not terminate within 8s' }), 8000);

		instance.once('exit', () => settle({ ok: true }));
		instance.once('error', (error) => settle({ ok: false, reason: `process error: ${error.message}` }));
		instance.kill();
	});
}

async function deleteCollection(vendor: string, collection: string): Promise<CleanupResult> {
	try {
		const response = await request(getUrl(vendor))
			.delete(`/collections/${collection}`)
			.set('Authorization', `Bearer ${common.USER.TESTS_FLOW.TOKEN}`);

		if (response.statusCode >= 400) {
			return { ok: false, reason: `DELETE /collections/${collection} on ${vendor} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE /collections/${collection} on ${vendor} threw ${String(error)}` };
	}
}

async function deleteResource(vendor: string, resource: string): Promise<CleanupResult> {
	try {
		const response = await request(getUrl(vendor))
			.delete(resource)
			.set('Authorization', `Bearer ${common.USER.TESTS_FLOW.TOKEN}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${vendor} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${vendor} threw ${String(error)}` };
	}
}

describe('/items QUERY_LIMIT_MAX enforcement', () => {
	// A spawned instance shares the database, which SQLite cannot do safely, so only server vendors run.
	const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
	const describeMax = supportedVendors.length > 0 ? describe : describe.skip;

	describeMax(`caps reads at a configured maximum of ${maxLimit}`, () => {
		const instances = {} as { [vendor: string]: ChildProcess };
		const envs = {} as { [vendor: string]: Env };
		const parentIds = {} as { [vendor: string]: number };
		const roleIds = {} as { [vendor: string]: string };
		const userIds = {} as { [vendor: string]: string };
		const seededPermissionIds = {} as { [vendor: string]: number[] };

		beforeAll(async () => {
			const promises = [];

			for (const vendor of supportedVendors) {
				const parent = await common.CreateCollection(vendor, { collection: parentCollection });
				expect(parent.collection).toBe(parentCollection);

				const child = await common.CreateCollection(vendor, { collection: childCollection });
				expect(child.collection).toBe(childCollection);

				const perms = await common.CreateCollection(vendor, { collection: permsCollection });
				expect(perms.collection).toBe(permsCollection);

				const titleField = await common.CreateField(vendor, {
					collection: parentCollection,
					field: 'title',
					type: 'string',
				});

				expect(titleField.field).toBe('title');

				const o2m = await common.CreateFieldO2M(vendor, {
					collection: parentCollection,
					field: 'children',
					otherCollection: childCollection,
					otherField: 'parent',
				});

				expect(o2m.relation).toBeDefined();

				const parents = await common.CreateItem(vendor, {
					collection: parentCollection,
					item: Array.from({ length: parentCount }, (_, index) => ({ title: `parent-${index}` })),
				});

				expect(parents).toHaveLength(parentCount);

				const parentId = parents[0].id;
				parentIds[vendor] = parentId;

				const children = await common.CreateItem(vendor, {
					collection: childCollection,
					item: Array.from({ length: childCount }, () => ({ parent: parentId })),
				});

				expect(children).toHaveLength(childCount);

				const role = await common.CreateRole(vendor, {
					name: permsRoleName,
					appAccessEnabled: true,
					adminAccessEnabled: false,
				});

				expect(role.id).toBeDefined();
				roleIds[vendor] = role.id;

				const user = await common.CreateUser(vendor, {
					token: permsUserToken,
					email: permsUserEmail,
					role: role.id,
				});

				expect(user.id).toBeDefined();
				userIds[vendor] = user.id;

				const permissionIds: number[] = [];

				for (const target of permissionTargets) {
					const created = await request(getUrl(vendor))
						.post('/permissions')
						.set('Authorization', `Bearer ${adminToken}`)
						.send({ role: role.id, collection: target.collection, action: target.action, fields: ['*'] });

					expect(created.statusCode).toBe(200);
					permissionIds.push(created.body.data.id);
				}

				expect(permissionIds).toHaveLength(permsCount);
				seededPermissionIds[vendor] = permissionIds;

				const env = cloneDeep(config.envs);
				env[vendor].QUERY_LIMIT_MAX = String(maxLimit);

				const port = Number(env[vendor]!.PORT) + 450;
				env[vendor]!.PORT = String(port);

				instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
					cwd: paths.cwd,
					env: env[vendor],
				});

				envs[vendor] = env;
				promises.push(awaitDirectusConnection(port));
			}

			await Promise.all(promises);
		}, 300000);

		afterAll(async () => {
			const failures: string[] = [];

			const terminations = await Promise.all(supportedVendors.map((vendor) => terminate(instances[vendor])));

			terminations.forEach((result, index) => {
				if (!result.ok) failures.push(`terminate ${supportedVendors[index]}: ${result.reason}`);
			});

			const deletions = await Promise.all(
				supportedVendors.map(async (vendor) => {
					const vendorFailures: string[] = [];

					// Delete the user before its role; role deletion drops the seeded permission rows.
					if (userIds[vendor]) {
						const result = await deleteResource(vendor, `/users/${userIds[vendor]}`);
						if (!result.ok) vendorFailures.push(result.reason);
					}

					if (roleIds[vendor]) {
						const result = await deleteResource(vendor, `/roles/${roleIds[vendor]}`);
						if (!result.ok) vendorFailures.push(result.reason);
					}

					// Drop the child collection before the parent so the m2o relation is gone first.
					for (const collection of [childCollection, parentCollection, permsCollection]) {
						const result = await deleteCollection(vendor, collection);
						if (!result.ok) vendorFailures.push(result.reason);
					}

					return vendorFailures;
				})
			);

			deletions.forEach((vendorFailures) => failures.push(...vendorFailures));

			if (failures.length > 0) {
				throw new Error(`Query limit test teardown failures: ${failures.join('; ')}`);
			}
		}, 60000);

		it.each(supportedVendors)('%s caps an unlimited top-level read at the maximum', async (vendor) => {
			const env = envs[vendor]!;

			const uncapped = await request(getUrl(vendor))
				.get(`/items/${parentCollection}`)
				.query({ limit: -1, fields: 'id' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(uncapped.body.data).toHaveLength(parentCount);

			const capped = await request(getUrl(vendor, env))
				.get(`/items/${parentCollection}`)
				.query({ limit: -1, fields: 'id' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(capped.body.data).toHaveLength(maxLimit);
		});

		it.each(supportedVendors)('%s rejects a top-level limit above the maximum with INVALID_QUERY', async (vendor) => {
			const env = envs[vendor]!;

			const response = await request(getUrl(vendor, env))
				.get(`/items/${parentCollection}`)
				.query({ limit: maxLimit + 1 })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(response.statusCode).toBe(400);
			expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
		});

		it.each(supportedVendors)('%s caps a relational child read at the maximum', async (vendor) => {
			const env = envs[vendor]!;
			const parentId = parentIds[vendor];

			const capped = await request(getUrl(vendor, env))
				.get(`/items/${parentCollection}/${parentId}`)
				.query({ fields: 'id,children.id' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(capped.body.data.children).toHaveLength(maxLimit);

			const uncapped = await request(getUrl(vendor))
				.get(`/items/${parentCollection}/${parentId}`)
				.query({ fields: 'id,children.id' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(uncapped.body.data.children).toHaveLength(childCount);
		});

		it.each(supportedVendors)('%s enforces the maximum on a SEARCH body limit', async (vendor) => {
			const env = envs[vendor]!;

			const atMax = await request(getUrl(vendor, env))
				.search(`/items/${parentCollection}`)
				.send({ query: { limit: maxLimit, fields: ['id'] } })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(atMax.statusCode).toBe(200);
			expect(atMax.body.data).toHaveLength(maxLimit);

			const overMax = await request(getUrl(vendor, env))
				.search(`/items/${parentCollection}`)
				.send({ query: { limit: maxLimit + 1 } })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(overMax.statusCode).toBe(400);
			expect(overMax.body.errors[0].extensions.code).toBe('INVALID_QUERY');
		});

		it.each(supportedVendors)('%s enforces the maximum on a nested GraphQL limit', async (vendor) => {
			const env = envs[vendor]!;
			const parentId = parentIds[vendor];

			const overMax = await requestGraphQL(getUrl(vendor, env), false, adminToken, {
				query: {
					[parentCollection]: {
						__args: { filter: { id: { _eq: parentId } } },
						children: {
							__args: { limit: maxLimit + 1 },
							id: true,
						},
					},
				},
			});

			expect(overMax.body.errors).toBeDefined();
			expect(overMax.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const atMax = await requestGraphQL(getUrl(vendor, env), false, adminToken, {
				query: {
					[parentCollection]: {
						__args: { filter: { id: { _eq: parentId } } },
						children: {
							__args: { limit: maxLimit },
							id: true,
						},
					},
				},
			});

			expect(atMax.body.errors).toBeUndefined();
			expect(atMax.body.data[parentCollection][0].children).toHaveLength(maxLimit);
		});

		it.each(supportedVendors)(
			"%s returns a role's full permission set to an app user despite the maximum",
			async (vendor) => {
				const env = envs[vendor]!;

				const response = await request(getUrl(vendor, env))
					.get('/permissions')
					.query({ 'filter[role][_eq]': roleIds[vendor] })
					.set('Authorization', `Bearer ${permsUserToken}`);

				expect(response.statusCode).toBe(200);

				// App-access permissions are synthetic and carry no ID; only stored rows do.
				const storedIds = (response.body.data as { id?: number }[])
					.map((permission) => permission.id)
					.filter((id): id is number => typeof id === 'number');

				expect(storedIds.slice().sort((a, b) => a - b)).toEqual(
					seededPermissionIds[vendor]!.slice().sort((a, b) => a - b)
				);
			}
		);
	});
});
