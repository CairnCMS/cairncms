import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import { createApiTest, type Api } from '../../fixtures/environment';
import { describeForVendors } from '../../fixtures/applicability';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const mainCollection = 'test_cache_ds_main';
const ignoredCollection = 'test_cache_ds_ignored';
const cacheStatusHeader = 'x-cache-status';

type Seed = {
	shareTokenAlpha: string;
	shareTokenBeta: string;
};

type Cache = { seed: Seed; rows: Record<string, any[]> };

const test = createApiTest({
	absoluteOrigin: true,
	env: {
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'true',
		CACHE_STORE: 'memory',
		CACHE_STATUS_HEADER: 'x-cache-status',
		CACHE_NAMESPACE: 'cairncms-cache-data-studio',
		CACHE_AUTO_PURGE_IGNORE_LIST: `directus_activity,directus_presets,${ignoredCollection}`,
	},
}).extend<{ cacheState: Prerequisite<Cache>; cache: Cache }>({
	cacheState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<Cache>(
				async (ready) => {
					const url = api.url;

					const post = async (path: string, payload: Record<string, unknown>) => {
						const response = await setupRequest(url)
							.post(path)
							.set('Authorization', `Bearer ${api.adminToken}`)
							.send(payload);

						expect(response.statusCode).toBeLessThan(300);
						return response.body.data;
					};

					const authShare = async (share: string) => {
						const response = await request(url).post('/shares/auth').send({ share });
						expect(response.statusCode).toBeLessThan(300);
						return response.body.data.access_token as string;
					};

					await CreateCollection(api, {
						collection: mainCollection,
						fields: [
							{ field: 'title', type: 'string' },
							{ field: 'sort', type: 'integer' },
						],
						meta: { sort_field: 'sort' },
					});

					await CreateCollection(api, {
						collection: ignoredCollection,
						fields: [{ field: 'title', type: 'string' }],
					});

					const alpha = await post(`/items/${mainCollection}`, { title: 'ds-alpha' });
					const beta = await post(`/items/${mainCollection}`, { title: 'ds-beta' });

					const role = await post('/roles', { name: 'cache-ds-role', app_access: false, admin_access: false });

					await post('/permissions', { role: role.id, collection: mainCollection, action: 'read', fields: ['*'] });

					const shareAlpha = await post('/shares', {
						collection: mainCollection,
						item: alpha.id,
						role: role.id,
						name: 'ds-share-alpha',
					});

					const shareBeta = await post('/shares', {
						collection: mainCollection,
						item: beta.id,
						role: role.id,
						name: 'ds-share-beta',
					});

					const seed = {
						shareTokenAlpha: await authShare(shareAlpha.id),
						shareTokenBeta: await authShare(shareBeta.id),
					};

					const rows: Record<string, any[]> = {};
					for (const table of [mainCollection, ignoredCollection]) rows[table] = await api.database(table);

					try {
						await ready({ seed, rows });
					} finally {
						if (api.available()) {
							for (const path of [
								`/collections/${mainCollection}`,
								`/collections/${ignoredCollection}`,
								`/roles/${role.id}`,
							]) {
								try {
									await setupRequest(api.url).delete(path).auth(api.adminToken, { type: 'bearer' }).expect(204);
								} catch (error) {
									teardownFailures.push(error);
								}
							}
						}
					}
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	cache: [
		async ({ api, cacheState, task, skip }, use) => {
			const state = requirePrerequisite(cacheState, 'response-cache schema, permissions and shares', { task, skip });

			for (const [table, rows] of Object.entries(state.rows)) {
				await api.database(table).delete();
				if (rows.length) await api.database(table).insert(rows);
			}

			await request(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' }).expect(200);
			await use(state);
		},
		{ auto: true },
	],
});

describeForVendors(
	'Response cache for Data Studio requests',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'This cache scenario has not been validated on SQLite.',
	() => {
		const studioReferer = (api: Api) => `${api.url}/admin/content`;

		async function clearCache(api: Api) {
			const response = await request(api.url)
				.post('/utils/cache/clear')
				.set('Authorization', `Bearer ${api.adminToken}`);

			expect(response.statusCode).toBe(200);
		}

		const studioGet = (api: Api, path: string, token = api.adminToken) =>
			request(api.url).get(path).set('Authorization', `Bearer ${token}`).set('Referer', studioReferer(api));

		const write = (api: Api, path: string, payload: Record<string, unknown>) =>
			request(api.url).post(path).set('Authorization', `Bearer ${api.adminToken}`).send(payload);

		async function primeMain(api: Api) {
			await clearCache(api);

			const miss = await studioGet(api, `/items/${mainCollection}`);
			expect(miss.statusCode).toBe(200);
			expect(miss.headers[cacheStatusHeader]).toBe('MISS');

			const hit = await studioGet(api, `/items/${mainCollection}`);
			expect(hit.statusCode).toBe(200);
			expect(hit.headers[cacheStatusHeader]).toBe('HIT');
		}

		test('caches a Data Studio read as MISS then HIT', async ({ api }) => {
			await primeMain(api);
		});

		test('purges the Data Studio read after a write to the same collection', async ({ api }) => {
			await primeMain(api);

			const created = await write(api, `/items/${mainCollection}`, { title: 'ds-new' });
			expect(created.statusCode).toBeLessThan(300);

			const after = await studioGet(api, `/items/${mainCollection}`);
			expect(after.statusCode).toBe(200);
			expect(after.headers[cacheStatusHeader]).toBe('MISS');
		});

		test('never caches a Data Studio read of an ignored collection', async ({ api }) => {
			await clearCache(api);

			const first = await studioGet(api, `/items/${ignoredCollection}`);
			expect(first.statusCode).toBe(200);
			expect(first.headers[cacheStatusHeader]).toBe('MISS');

			const second = await studioGet(api, `/items/${ignoredCollection}`);
			expect(second.statusCode).toBe(200);
			expect(second.headers[cacheStatusHeader]).toBe('MISS');
		});

		test('keeps a primed read when an ignored collection is written', async ({ api }) => {
			await primeMain(api);

			const created = await write(api, `/items/${ignoredCollection}`, { title: 'ds-ignored' });
			expect(created.statusCode).toBeLessThan(300);

			const after = await studioGet(api, `/items/${mainCollection}`);
			expect(after.statusCode).toBe(200);
			expect(after.headers[cacheStatusHeader]).toBe('HIT');
		});

		test('keeps a primed read when last_page is tracked', async ({ api }) => {
			await primeMain(api);

			const tracked = await request(api.url)
				.patch('/users/me/track/page')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({ last_page: '/content' });

			expect(tracked.statusCode).toBeLessThan(300);

			const after = await studioGet(api, `/items/${mainCollection}`);
			expect(after.statusCode).toBe(200);
			expect(after.headers[cacheStatusHeader]).toBe('HIT');
		});

		test('purges the read after a manual sort', async ({ api }) => {
			await primeMain(api);

			const rows = await request(api.url)
				.get(`/items/${mainCollection}`)
				.query({ fields: 'id', sort: 'id', limit: 2 })
				.set('Authorization', `Bearer ${api.adminToken}`);

			expect(rows.statusCode).toBe(200);
			const ids = rows.body.data.map((row: { id: number }) => row.id);
			expect(ids).toHaveLength(2);

			const sorted = await request(api.url)
				.post(`/utils/sort/${mainCollection}`)
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({ item: ids[0], to: ids[1] });

			expect(sorted.statusCode).toBe(200);

			const after = await studioGet(api, `/items/${mainCollection}`);
			expect(after.statusCode).toBe(200);
			expect(after.headers[cacheStatusHeader]).toBe('MISS');
		});

		test('segregates Data Studio caches per accountability', async ({ api, cache }) => {
			const seed = cache.seed;
			await clearCache(api);

			const aFirst = await studioGet(api, `/items/${mainCollection}`, seed.shareTokenAlpha);
			expect(aFirst.statusCode).toBe(200);
			expect(aFirst.headers[cacheStatusHeader]).toBe('MISS');
			const aBody = JSON.stringify(aFirst.body.data);
			expect(aBody).toContain('ds-alpha');
			expect(aBody).not.toContain('ds-beta');

			const aRepeat = await studioGet(api, `/items/${mainCollection}`, seed.shareTokenAlpha);
			expect(aRepeat.statusCode).toBe(200);
			expect(aRepeat.headers[cacheStatusHeader]).toBe('HIT');

			const bFirst = await studioGet(api, `/items/${mainCollection}`, seed.shareTokenBeta);
			expect(bFirst.statusCode).toBe(200);
			expect(bFirst.headers[cacheStatusHeader]).toBe('MISS');
			const bBody = JSON.stringify(bFirst.body.data);
			expect(bBody).toContain('ds-beta');
			expect(bBody).not.toContain('ds-alpha');
		});
	}
);
