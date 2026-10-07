import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, vi } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import type { Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { createRedisTest, type RedisService } from '../../fixtures/redis';
import request from '../../fixtures/request';
import { CreateCollection } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const namespace = 'cairncms-schema-apply-cache';
const cacheStatusHeader = 'x-cache-status';

type Peers = { a: string; b: string; env: Record<string, string> };

const test = createRedisTest('redis6').extend<{ peersState: Prerequisite<Peers>; peers: Peers }>({
	peersState: [
		async ({ apiState, redisState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!redisState.ok) return use(redisState);
			const api = apiState.value;

			const env = {
				CACHE_ENABLED: 'true',
				CACHE_AUTO_PURGE: 'false',
				CACHE_SCHEMA: 'true',
				CACHE_STORE: 'redis',
				CACHE_REDIS: redisState.value.url,
				CACHE_NAMESPACE: namespace,
				CACHE_STATUS_HEADER: cacheStatusHeader,
				MESSENGER_STORE: 'memory',
			};

			await capturePrerequisite<Peers>(
				async (ready) => {
					const a = await api.start(env);

					try {
						const b = await api.start(env);

						try {
							await ready({ a: a.url, b: b.url, env });
						} finally {
							await api.stop(b.child);
						}
					} finally {
						await api.stop(a.child);
					}
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	peers: [
		async ({ api, redis, peersState, task, skip }, use) => {
			void api;
			void redis;
			await use(requirePrerequisite(peersState, 'schema apply cache peers', { task, skip }));
		},
		{ auto: true },
	],
});

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

function asAdmin(api: Api, url: string) {
	return {
		get: (path: string) => request(url).get(path).set('Authorization', `Bearer ${api.adminToken}`),
		post: (path: string) => request(url).post(path).set('Authorization', `Bearer ${api.adminToken}`),
		delete: (path: string) => request(url).delete(path).set('Authorization', `Bearer ${api.adminToken}`),
	};
}

async function deleteCollection(api: Api, url: string, collection: string) {
	const res = await asAdmin(api, url).delete(`/collections/${collection}`);
	expect([204, 403]).toContain(res.statusCode);
}

async function seedCollection(api: Api, url: string, collection: string) {
	await CreateCollection(
		{ ...api, url },
		{ collection, fields: [{ field: 'title', type: 'string', meta: {}, schema: {} }] }
	);

	const created = await asAdmin(api, url).post(`/items/${collection}`).send({ title: 'first' });
	expect(created.statusCode).toBe(200);
}

async function resetCaches(api: Api, url: string) {
	const res = await asAdmin(api, url).post('/utils/cache/clear');
	expect(res.statusCode).toBe(200);
}

async function warmPeer(api: Api, url: string, collection: string) {
	await resetCaches(api, url);
	expect((await asAdmin(api, url).get(`/items/${collection}`)).statusCode).toBe(200);
}

async function expectSharedSchemaHash(redis: RedisService) {
	expect(await redis.client.keys(`${namespace}_schema_shared*`)).not.toEqual([]);
}

async function snapshotWithField(api: Api, url: string, collection: string, field: string) {
	const res = await asAdmin(api, url).get('/schema/snapshot');
	expect(res.statusCode).toBe(200);

	const snapshot = res.body.data;

	snapshot.fields.push({
		collection,
		field,
		type: 'string',
		meta: { collection, field, interface: 'input' },
		schema: { name: field, table: collection, data_type: 'varchar' },
	});

	return snapshot;
}

async function applySnapshot(api: Api, url: string, snapshot: unknown) {
	const diffRes = await asAdmin(api, url).post('/schema/diff').send(snapshot).set('Content-type', 'application/json');
	expect(diffRes.statusCode).toBe(200);

	const applyRes = await asAdmin(api, url)
		.post('/schema/apply')
		.send(diffRes.body.data)
		.set('Content-type', 'application/json');

	expect(applyRes.statusCode).toBe(204);
}

async function readRow(api: Api, url: string, collection: string) {
	const res = await asAdmin(api, url).get(`/items/${collection}`).query({ fields: '*', limit: 2 });
	expect(res.statusCode).toBe(200);
	expect(res.headers[cacheStatusHeader]).toBe('MISS');
	return res.body.data[0];
}

describeForVendors(
	'Schema apply cache invalidation',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'Schema propagation between server processes has not been validated on SQLite.',
	() => {
		describe('a schema apply on one process is visible to a peer sharing the cache store', () => {
			test('REST', async ({ api, redis, peers, vendor }) => {
				const collection = `test_apply_cache_peer_${vendor}`;
				await deleteCollection(api, peers.a, collection);

				try {
					await seedCollection(api, peers.a, collection);
					await warmPeer(api, peers.b, collection);
					await expectSharedSchemaHash(redis);

					await applySnapshot(api, peers.a, await snapshotWithField(api, peers.a, collection, 'subtitle'));

					expect(await readRow(api, peers.b, collection)).toHaveProperty('subtitle');
				} finally {
					await deleteCollection(api, peers.a, collection);
				}
			});
		});

		describe('a CLI schema apply is visible to a running peer sharing the cache store', () => {
			test('REST', async ({ api, redis, peers, vendor }) => {
				const collection = `test_apply_cache_cli_${vendor}`;
				await deleteCollection(api, peers.a, collection);

				try {
					await seedCollection(api, peers.a, collection);
					await warmPeer(api, peers.b, collection);
					await expectSharedSchemaHash(redis);

					const file = join(api.directory, `schema-apply-cache-${vendor}.json`);
					await writeFile(file, JSON.stringify(await snapshotWithField(api, peers.a, collection, 'subtitle')));

					const result = await api.cli(['schema', 'apply', '--yes', file], { env: peers.env });
					expect(result.status, result.stderr).toBe(0);

					expect(await readRow(api, peers.b, collection)).toHaveProperty('subtitle');
				} finally {
					await deleteCollection(api, peers.a, collection);
				}
			});
		});

		describe('a schema apply clears cached item responses when auto purge is off', () => {
			test('REST', async ({ api, redis, peers, vendor }) => {
				const collection = `test_apply_cache_response_${vendor}`;
				await deleteCollection(api, peers.a, collection);

				try {
					await seedCollection(api, peers.a, collection);
					await resetCaches(api, peers.b);
					expect((await asAdmin(api, peers.b).get(`/items/${collection}`)).headers[cacheStatusHeader]).toBe('MISS');
					expect((await asAdmin(api, peers.b).get(`/items/${collection}`)).headers[cacheStatusHeader]).toBe('HIT');
					await expectSharedSchemaHash(redis);

					await applySnapshot(api, peers.a, await snapshotWithField(api, peers.a, collection, 'subtitle'));

					const after = await asAdmin(api, peers.b).get(`/items/${collection}`);
					expect(after.statusCode).toBe(200);
					expect(after.headers[cacheStatusHeader]).toBe('MISS');
					expect(after.body.data[0]).toHaveProperty('subtitle');
				} finally {
					await deleteCollection(api, peers.a, collection);
				}
			});
		});
	}
);
