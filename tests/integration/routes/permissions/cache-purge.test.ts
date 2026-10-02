import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createApiTest, type Api } from '../../fixtures/environment';
import { describeForVendors } from '../../fixtures/applicability';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const collection = 'test_perms_cache_purge';
const cacheStatusHeader = 'x-cache-status';

type Seed = { roleId: string };

type Cache = Seed & { rows: Record<string, any[]> };

const test = createApiTest({
	absoluteOrigin: false,
	env: {
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'false',
		CACHE_STORE: 'memory',
		CACHE_STATUS_HEADER: 'x-cache-status',
		CACHE_NAMESPACE: 'cairncms-perms-cache-purge',
	},
}).extend<{ cacheState: Prerequisite<Cache>; cache: Cache }>({
	cacheState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<Cache>(
				async (ready) => {
					await CreateCollection(api, { collection });

					const role = await setupRequest(api.url)
						.post('/roles')
						.auth(api.adminToken, { type: 'bearer' })
						.send({ name: 'Tests Flow Role', admin_access: true, app_access: true })
						.expect(200);

					const seed = { roleId: role.body.data.id as string };

					const rows: Record<string, any[]> = {};
					for (const table of [collection]) rows[table] = await api.database(table);
					await ready({ ...seed, rows });
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	cache: [
		async ({ api, cacheState, task, skip }, use) => {
			const state = requirePrerequisite(cacheState, 'response-cache schema and permissions', { task, skip });

			for (const [table, rows] of Object.entries(state.rows)) {
				await api.database(table).delete();
				if (rows.length) await api.database(table).insert(rows);
			}

			await api.database('directus_permissions').where({ role: state.roleId, collection }).delete();
			await request(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' }).expect(200);
			await use(state);
		},
		{ auto: true },
	],
});

describeForVendors(
	'Permissions cache purging',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'This cache scenario has not been validated on SQLite.',
	() => {
		async function primeCache(api: Api) {
			await request(api.url).post('/utils/cache/clear').set('Authorization', `Bearer ${api.adminToken}`);
			await request(api.url).get(`/items/${collection}`).set('Authorization', `Bearer ${api.adminToken}`);
		}

		function readItems(api: Api) {
			return request(api.url).get(`/items/${collection}`).set('Authorization', `Bearer ${api.adminToken}`);
		}

		function createPermission(api: Api, roleId: string, action: string) {
			return setupRequest(api.url)
				.post('/permissions')
				.send({ role: roleId, collection, action })
				.set('Authorization', `Bearer ${api.adminToken}`);
		}

		describe('GET /items response cache', () => {
			test('serves a cached item response as a HIT when nothing changes', async ({ api }) => {
				await primeCache(api);
				const response = await readItems(api);

				expect(response.statusCode).toBe(200);
				expect(response.headers[cacheStatusHeader]).toBe('HIT');
			});

			test('purges the cached item response after a permission is created', async ({ api, cache }) => {
				await primeCache(api);

				const created = await createPermission(api, cache.roleId, 'read');
				expect(created.statusCode).toBe(200);

				const response = await readItems(api);

				expect(response.statusCode).toBe(200);
				expect(response.headers[cacheStatusHeader]).toBe('MISS');
			});

			test('purges the cached item response after a permission is updated', async ({ api, cache }) => {
				const created = await createPermission(api, cache.roleId, 'create');
				expect(created.statusCode).toBe(200);
				const permissionId = created.body.data.id;

				await primeCache(api);

				const updated = await request(api.url)
					.patch(`/permissions/${permissionId}`)
					.send({ action: 'update' })
					.set('Authorization', `Bearer ${api.adminToken}`);

				expect(updated.statusCode).toBe(200);

				const response = await readItems(api);

				expect(response.statusCode).toBe(200);
				expect(response.headers[cacheStatusHeader]).toBe('MISS');
			});

			test('purges the cached item response after a permission is deleted', async ({ api, cache }) => {
				const created = await createPermission(api, cache.roleId, 'delete');
				expect(created.statusCode).toBe(200);
				const permissionId = created.body.data.id;

				await primeCache(api);

				const deleted = await request(api.url)
					.delete(`/permissions/${permissionId}`)
					.set('Authorization', `Bearer ${api.adminToken}`);

				expect(deleted.statusCode).toBeLessThan(300);

				const response = await readItems(api);

				expect(response.statusCode).toBe(200);
				expect(response.headers[cacheStatusHeader]).toBe('MISS');
			});
		});
	}
);
