import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';

// SQLite cannot safely share a single file across multiple instances, and this
// test spawns a dedicated cache-configured instance alongside the default one.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeFn = supportedVendors.length > 0 ? describe : describe.skip;

const collection = 'test_perms_cache_purge';
const cacheStatusHeader = 'x-cache-status';
const adminToken = common.USER.ADMIN.TOKEN;
const roleId = common.ROLE.TESTS_FLOW.ID;

describeFn('Permissions cache purging', () => {
	const instances = {} as { [vendor: string]: ChildProcess };
	const envs = {} as { [vendor: string]: Env };

	beforeAll(async () => {
		const promises = [];

		for (const vendor of supportedVendors) {
			const env = cloneDeep(config.envs);
			env[vendor].CACHE_ENABLED = 'true';
			env[vendor].CACHE_AUTO_PURGE = 'false';
			env[vendor].CACHE_STORE = 'memory';
			env[vendor].CACHE_STATUS_HEADER = cacheStatusHeader;
			env[vendor].CACHE_NAMESPACE = 'cairncms-perms-cache-purge';

			const port = Number(env[vendor]!.PORT) + 150;
			env[vendor]!.PORT = String(port);

			instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
				cwd: paths.cwd,
				env: env[vendor],
			});

			envs[vendor] = env;
			promises.push(awaitDirectusConnection(port));
		}

		await Promise.all(promises);

		for (const vendor of supportedVendors) {
			await common.CreateCollection(vendor, { collection, env: envs[vendor] });
		}
	}, 300000);

	afterAll(() => {
		for (const vendor of supportedVendors) {
			instances[vendor]!.kill();
		}
	});

	async function primeCache(vendor: string, env: Env) {
		await request(getUrl(vendor, env)).post('/utils/cache/clear').set('Authorization', `Bearer ${adminToken}`);
		await request(getUrl(vendor, env)).get(`/items/${collection}`).set('Authorization', `Bearer ${adminToken}`);
	}

	function readItems(vendor: string, env: Env) {
		return request(getUrl(vendor, env)).get(`/items/${collection}`).set('Authorization', `Bearer ${adminToken}`);
	}

	function createPermission(vendor: string, env: Env, action: string) {
		return request(getUrl(vendor, env))
			.post('/permissions')
			.send({ role: roleId, collection, action })
			.set('Authorization', `Bearer ${adminToken}`);
	}

	describe('GET /items response cache', () => {
		it.each(supportedVendors)('%s serves a cached item response as a HIT when nothing changes', async (vendor) => {
			const env = envs[vendor]!;

			await primeCache(vendor, env);
			const response = await readItems(vendor, env);

			expect(response.statusCode).toBe(200);
			expect(response.headers[cacheStatusHeader]).toBe('HIT');
		});

		it.each(supportedVendors)('%s purges the cached item response after a permission is created', async (vendor) => {
			const env = envs[vendor]!;

			await primeCache(vendor, env);

			const created = await createPermission(vendor, env, 'read');
			expect(created.statusCode).toBe(200);

			const response = await readItems(vendor, env);

			expect(response.statusCode).toBe(200);
			expect(response.headers[cacheStatusHeader]).toBe('MISS');
		});

		it.each(supportedVendors)('%s purges the cached item response after a permission is updated', async (vendor) => {
			const env = envs[vendor]!;

			const created = await createPermission(vendor, env, 'create');
			expect(created.statusCode).toBe(200);
			const permissionId = created.body.data.id;

			await primeCache(vendor, env);

			const updated = await request(getUrl(vendor, env))
				.patch(`/permissions/${permissionId}`)
				.send({ action: 'update' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(updated.statusCode).toBe(200);

			const response = await readItems(vendor, env);

			expect(response.statusCode).toBe(200);
			expect(response.headers[cacheStatusHeader]).toBe('MISS');
		});

		it.each(supportedVendors)('%s purges the cached item response after a permission is deleted', async (vendor) => {
			const env = envs[vendor]!;

			const created = await createPermission(vendor, env, 'delete');
			expect(created.statusCode).toBe(200);
			const permissionId = created.body.data.id;

			await primeCache(vendor, env);

			const deleted = await request(getUrl(vendor, env))
				.delete(`/permissions/${permissionId}`)
				.set('Authorization', `Bearer ${adminToken}`);

			expect(deleted.statusCode).toBeLessThan(300);

			const response = await readItems(vendor, env);

			expect(response.statusCode).toBe(200);
			expect(response.headers[cacheStatusHeader]).toBe('MISS');
		});
	});
});
