import { describe, expect, vi } from 'vitest';
import { createRedisTest } from '../../fixtures/redis';
import { describeForVendors } from '../../fixtures/applicability';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import * as common from '../../fixtures/schema';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const namespace = 'directus-schema-cache';

const test = createRedisTest('redis6', {
	extensions: ['cairncms-extension-schema-isolation'],
	env: {
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'true',
		CACHE_SCHEMA: 'true',
		CACHE_STORE: 'memory',
		CACHE_NAMESPACE: namespace,
	},
}).extend<{ nodesState: Prerequisite<string[]>; nodes: string[] }>({
	nodesState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<string[]>(
				async (ready) => {
					const second = await api.start({ CACHE_NAMESPACE: namespace + '2' });
					// These peers need independent memory messengers to exercise absent propagation.
					const third = await api.start({ CACHE_NAMESPACE: namespace + '3', MESSENGER_STORE: 'memory' });
					const fourth = await api.start({ CACHE_NAMESPACE: namespace + '4', MESSENGER_STORE: 'memory' });
					await ready([api.url, second.url, third.url, fourth.url]);
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	nodes: async ({ api, redis, nodesState, task, skip }, use) => {
		void api;
		void redis;
		await use(requirePrerequisite(nodesState, 'schema cache companion APIs', { task, skip }));
	},
});

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

test('request schema edits do not change another tenant read', async ({ api }) => {
	const collection = 'schema_cache_tenant_records';
	const tenants = ['a', 'b'] as const;
	const tokens = { a: 'SchemaCacheTenantAToken', b: 'SchemaCacheTenantBToken' };

	await common.CreateCollection(api, {
		collection,
		fields: [
			{ field: 'tenant', type: 'string' },
			{ field: 'secret', type: 'string', meta: { special: ['conceal'] } },
		],
	});

	for (const tenant of tenants) {
		const role = await common.CreateRole(api, {
			name: `Schema Cache Tenant ${tenant}`,
			appAccessEnabled: false,
			adminAccessEnabled: false,
		});

		await setupRequest(api.url)
			.post('/users')
			.auth(api.adminToken, { type: 'bearer' })
			.send({ email: `schema-cache-${tenant}@example.com`, token: tokens[tenant], role: role.id })
			.expect(200);

		await setupRequest(api.url)
			.post('/permissions')
			.auth(api.adminToken, { type: 'bearer' })
			.send({
				role: role.id,
				collection,
				action: 'read',
				fields: ['id', 'tenant', 'secret'],
				permissions: { tenant: { _eq: tenant } },
			})
			.expect(200);
	}

	const created = await setupRequest(api.url)
		.post(`/items/${collection}`)
		.auth(api.adminToken, { type: 'bearer' })
		.send(tenants.map((tenant) => ({ tenant, secret: `tenant-${tenant}-secret` })))
		.expect(200);

	const records = created.body.data as { id: number; tenant: string; secret: string }[];
	expect(records.map(({ tenant }) => tenant)).toEqual(tenants);

	const server = await api.start({
		CACHE_ENABLED: 'false',
		CACHE_SCHEMA: 'true',
		CACHE_SYSTEM_TTL: '0',
		MESSENGER_STORE: 'memory',
	});

	try {
		const read = (tenant: (typeof tenants)[number]) =>
			request(server.url).get(`/items/${collection}`).auth(tokens[tenant], { type: 'bearer' }).expect(200);

		for (const tenant of tenants) {
			const before = await read(tenant);
			const item = records.find((record) => record.tenant === tenant)!;
			expect(before.body.data).toEqual([{ id: item.id, tenant, secret: '**********' }]);
		}

		const revealed = await request(server.url)
			.post('/cairncms-extension-schema-isolation/reveal')
			.auth(tokens.a, { type: 'bearer' })
			.expect(200);

		expect(revealed.body.data).toEqual([{ id: records[0]!.id, tenant: 'a', secret: 'tenant-a-secret' }]);

		for (const tenant of ['b', 'a'] as const) {
			const after = await read(tenant);
			const item = records.find((record) => record.tenant === tenant)!;
			expect(after.body.data).toEqual([{ id: item.id, tenant, secret: '**********' }]);
		}
	} finally {
		await api.stop(server.child);
	}
});

describeForVendors(
	'Schema Caching Tests',
	['postgres', 'mysql', 'maria'],
	'Schema propagation between server processes has not been validated on SQLite.',
	() => {
		const newCollectionName = 'schema-caching-test';

		test('shared Redis hash refreshes local schemas without messenger delivery', async ({ api, redis }) => {
			const collection = 'schema-caching-redis-test';

			const config = {
				CACHE_ENABLED: 'false',
				CACHE_STORE: 'redis',
				CACHE_REDIS: redis.url,
				CACHE_NAMESPACE: redis.namespace,
				CACHE_SYSTEM_TTL: '0',
				// Each process has its own messenger. Only the shared hash can invalidate its local snapshot.
				MESSENGER_STORE: 'memory',
			};

			const writer = await api.start(config);

			try {
				const reader = await api.start(config);

				try {
					await common.CreateCollection(
						{ ...api, url: writer.url },
						{ collection, fields: [{ field: 'label', type: 'string' }] }
					);

					const created = await setupRequest(writer.url)
						.post(`/items/${collection}`)
						.set('Authorization', `Bearer ${api.adminToken}`)
						.send({ label: 'before' })
						.expect(200);

					const item = { id: created.body.data.id, label: 'before' };

					const before = await request(reader.url)
						.get(`/items/${collection}`)
						.set('Authorization', `Bearer ${api.adminToken}`)
						.expect(200);

					expect(before.body.data).toEqual([item]);

					await common.CreateField(
						{ ...api, url: writer.url },
						{ collection, field: 'marker', type: 'string', schema: { default_value: 'current' } }
					);

					const after = await request(reader.url)
						.get(`/items/${collection}`)
						.set('Authorization', `Bearer ${api.adminToken}`)
						.expect(200);

					expect(after.body.data).toEqual([{ ...item, marker: 'current' }]);

					await setupRequest(writer.url)
						.delete(`/collections/${collection}`)
						.set('Authorization', `Bearer ${api.adminToken}`)
						.expect(204);

					const deleted = await request(reader.url)
						.get(`/items/${collection}`)
						.set('Authorization', `Bearer ${api.adminToken}`)
						.expect(403);

					expect(deleted.body.errors[0].extensions.code).toBe('FORBIDDEN');
				} finally {
					await api.stop(reader.child);
				}
			} finally {
				await api.stop(writer.child);
			}
		});

		describe('GET /collections/:collection', () => {
			describe('schema change propagates across nodes using messenger', () => {
				test('REST', async ({ api, nodes }) => {
					// Setup
					const env1 = nodes[0];
					const env2 = nodes[1];

					await common.CreateCollection({ ...api, url: env1 }, { collection: newCollectionName });

					await request(env1).post(`/utils/cache/clear`).set('Authorization', `Bearer ${api.adminToken}`);

					await request(env1).get(`/fields`).set('Authorization', `Bearer ${api.adminToken}`);

					await request(env2).post(`/utils/cache/clear`).set('Authorization', `Bearer ${api.adminToken}`);

					await request(env2).get(`/fields`).set('Authorization', `Bearer ${api.adminToken}`);

					// Action
					const responseBefore = await request(env1)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					const responseBefore2 = await request(env2)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					await request(env1)
						.delete(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					const responseAfter = await request(env1)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					const responseAfter2 = await request(env2)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					// Assert
					expect(responseBefore.statusCode).toBe(200);
					expect(responseBefore2.statusCode).toBe(200);
					expect(responseAfter.statusCode).toBe(403);
					expect(responseAfter2.statusCode).toBe(403);
				});
			});

			describe('schema change does not propagate across nodes without messenger', () => {
				test('REST', async ({ api, nodes }) => {
					// Setup
					const env3 = nodes[2];
					const env4 = nodes[3];

					await common.CreateCollection({ ...api, url: env3 }, { collection: newCollectionName });

					await request(env3).post(`/utils/cache/clear`).set('Authorization', `Bearer ${api.adminToken}`);

					await request(env3).get(`/fields`).set('Authorization', `Bearer ${api.adminToken}`);

					await request(env4).post(`/utils/cache/clear`).set('Authorization', `Bearer ${api.adminToken}`);

					await request(env4).get(`/fields`).set('Authorization', `Bearer ${api.adminToken}`);

					// Action
					const responseBefore = await request(env3)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					const responseBefore2 = await request(env4)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					await request(env3)
						.delete(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					const responseAfter = await request(env3)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					const responseAfter2 = await request(env4)
						.get(`/collections/${newCollectionName}`)
						.set('Authorization', `Bearer ${api.adminToken}`);

					// Assert
					expect(responseBefore.statusCode).toBe(200);
					expect(responseBefore2.statusCode).toBe(200);
					expect(responseAfter.statusCode).toBe(403);
					expect(responseAfter2.statusCode).toBe(200);
				});
			});
		});
	}
);
