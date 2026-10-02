import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createApiTest } from '../../fixtures/environment';
import { describeForVendors } from '../../fixtures/applicability';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const collection = 'test_cache_share_seg';
const cacheStatusHeader = 'x-cache-status';

type Seed = {
	itemsShareToken: string; // share scoped to the alpha item
	otherShareToken: string; // share scoped to the beta item, same role
	meShareA: string; // share id A (same scope/role as B)
	meShareB: string; // share id B
	meTokenA: string;
	meTokenB: string;
};

type Cache = { seed: Seed; rows: Record<string, any[]> };

const test = createApiTest({
	absoluteOrigin: false,
	env: {
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'false',
		CACHE_STORE: 'memory',
		CACHE_STATUS_HEADER: 'x-cache-status',
		CACHE_NAMESPACE: 'cairncms-cache-share-seg',
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
						collection,
						fields: [{ field: 'title', type: 'string' }],
					});

					const alpha = await post(`/items/${collection}`, { title: 'alpha-secret' });
					const beta = await post(`/items/${collection}`, { title: 'beta-secret' });

					const role = await post('/roles', { name: 'cache-share-role', app_access: false, admin_access: false });

					await post('/permissions', { role: role.id, collection, action: 'read', fields: ['*'] });

					const makeShare = (item: number | string) =>
						post('/shares', { collection, item, role: role.id, name: 'seg-share' });

					const shareAlpha = await makeShare(alpha.id);
					const shareBeta = await makeShare(beta.id);
					const shareMeA = await makeShare(alpha.id);
					const shareMeB = await makeShare(alpha.id);

					const seed = {
						itemsShareToken: await authShare(shareAlpha.id),
						otherShareToken: await authShare(shareBeta.id),
						meShareA: shareMeA.id,
						meShareB: shareMeB.id,
						meTokenA: await authShare(shareMeA.id),
						meTokenB: await authShare(shareMeB.id),
					};

					const rows: Record<string, any[]> = {};
					for (const table of [collection]) rows[table] = await api.database(table);
					await ready({ seed, rows });
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
	'Response cache authorization segmentation',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'This cache scenario has not been validated on SQLite.',
	() => {
		describe('read-data surface: /items caches per share and never serves one share the other content', () => {
			test('preserves cached authorization', async ({ api, cache }) => {
				const url = api.url;
				const seed = cache.seed;

				const listAs = (token: string) =>
					request(url).get(`/items/${collection}`).set('Authorization', `Bearer ${token}`);

				// Share alpha: first request is a MISS that populates its own scoped bucket.
				const alphaFirst = await listAs(seed.itemsShareToken);
				expect(alphaFirst.statusCode).toBe(200);
				expect(alphaFirst.headers[cacheStatusHeader]).toBe('MISS');
				expect(JSON.stringify(alphaFirst.body.data)).toContain('alpha-secret');

				// Repeat is a HIT: proves share alpha's response really is cached (not a vacuous pass).
				const alphaRepeat = await listAs(seed.itemsShareToken);
				expect(alphaRepeat.headers[cacheStatusHeader]).toBe('HIT');

				// Share beta hits the identical URL: MISS (its own bucket) and its own content, never alpha's.
				const beta = await listAs(seed.otherShareToken);
				expect(beta.statusCode).toBe(200);
				expect(beta.headers[cacheStatusHeader]).toBe('MISS');
				const betaBody = JSON.stringify(beta.body.data);
				expect(betaBody).toContain('beta-secret');
				expect(betaBody).not.toContain('alpha-secret');
			});
		});

		describe('share identity: /users/me caches per share and never serves one share another share id', () => {
			test('preserves cached authorization', async ({ api, cache }) => {
				const url = api.url;
				const seed = cache.seed;

				const meAs = (token: string) =>
					request(url).get('/users/me').query({ fields: 'share' }).set('Authorization', `Bearer ${token}`);

				// Share A: MISS then HIT proves its /users/me response is cached under its own bucket.
				const aFirst = await meAs(seed.meTokenA);
				expect(aFirst.statusCode).toBe(200);
				expect(aFirst.headers[cacheStatusHeader]).toBe('MISS');
				expect(aFirst.body.data.share).toBe(seed.meShareA);

				const aRepeat = await meAs(seed.meTokenA);
				expect(aRepeat.headers[cacheStatusHeader]).toBe('HIT');

				// Share B (same role and scope, different share id): MISS on the identical URL and its own id.
				const bFirst = await meAs(seed.meTokenB);
				expect(bFirst.statusCode).toBe(200);
				expect(bFirst.headers[cacheStatusHeader]).toBe('MISS');
				expect(bFirst.body.data.share).toBe(seed.meShareB);
			});
		});
	}
);
