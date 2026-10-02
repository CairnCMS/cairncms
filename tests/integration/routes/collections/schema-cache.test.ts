import { describe, expect, vi } from 'vitest';
import { createRedisTest } from '../../fixtures/redis';
import { describeForVendors } from '../../fixtures/applicability';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import * as common from '../../fixtures/schema';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const namespace = 'directus-schema-cache';

const test = createRedisTest('redis6', {
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
	nodes: [
		async ({ api, redis, nodesState, task, skip }, use) => {
			void api;
			void redis;
			await use(requirePrerequisite(nodesState, 'schema cache companion APIs', { task, skip }));
		},
		{ auto: true },
	],
});

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

describeForVendors(
	'Schema Caching Tests',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'Schema propagation between server processes has not been validated on SQLite.',
	() => {
		const newCollectionName = 'schema-caching-test';

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
