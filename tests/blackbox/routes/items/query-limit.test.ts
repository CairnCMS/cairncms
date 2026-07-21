import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { requestGraphQL } from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';

const adminToken = common.USER.ADMIN.TOKEN;
const parentCollection = 'test_items_query_limit_parent';
const childCollection = 'test_items_query_limit_child';
const maxLimit = 10;
const parentCount = 15;
const childCount = 15;

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

describe('/items QUERY_LIMIT_MAX enforcement', () => {
	// A spawned instance shares the database, which SQLite cannot do safely, so only server vendors run.
	const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
	const describeMax = supportedVendors.length > 0 ? describe : describe.skip;

	describeMax(`caps reads at a configured maximum of ${maxLimit}`, () => {
		const instances = {} as { [vendor: string]: ChildProcess };
		const envs = {} as { [vendor: string]: Env };
		const parentIds = {} as { [vendor: string]: number };

		beforeAll(async () => {
			const promises = [];

			for (const vendor of supportedVendors) {
				const parent = await common.CreateCollection(vendor, { collection: parentCollection });
				expect(parent.collection).toBe(parentCollection);

				const child = await common.CreateCollection(vendor, { collection: childCollection });
				expect(child.collection).toBe(childCollection);

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

					// Drop the child collection before the parent so the m2o relation is gone first.
					for (const collection of [childCollection, parentCollection]) {
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
	});
});
