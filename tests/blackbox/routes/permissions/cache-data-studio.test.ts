import config, { Env, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';

// SQLite cannot safely share a single file across the default and spawned instances, and this
// test spawns a dedicated cache-enabled instance alongside the default one.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeFn = supportedVendors.length > 0 ? describe : describe.skip;

const mainCollection = 'test_cache_ds_main';
const ignoredCollection = 'test_cache_ds_ignored';
const cacheStatusHeader = 'x-cache-status';
const adminToken = common.USER.ADMIN.TOKEN;

type Seed = {
	shareTokenAlpha: string;
	shareTokenBeta: string;
};

function awaitExit(instance: ChildProcess | undefined): Promise<void> {
	// An already-exited child never emits another exit event, so resolve immediately.
	if (!instance || instance.exitCode !== null || instance.signalCode !== null) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		instance.once('exit', () => resolve());
		instance.kill();
	});
}

describeFn('Response cache for Data Studio requests', () => {
	const instances = {} as { [vendor: string]: ChildProcess };
	const envs = {} as { [vendor: string]: Env };
	const seeds = {} as { [vendor: string]: Seed };
	const roleIds = {} as { [vendor: string]: string };

	beforeAll(async () => {
		const promises = [];

		for (const vendor of supportedVendors) {
			const env = cloneDeep(config.envs);
			env[vendor].CACHE_ENABLED = 'true';
			env[vendor].CACHE_AUTO_PURGE = 'true';
			env[vendor].CACHE_STORE = 'memory';
			env[vendor].CACHE_STATUS_HEADER = cacheStatusHeader;
			env[vendor].CACHE_NAMESPACE = 'cairncms-cache-data-studio';
			// Keep the shipped defaults so activity rows written during audited mutations do not purge.
			env[vendor].CACHE_AUTO_PURGE_IGNORE_LIST = `directus_activity,directus_presets,${ignoredCollection}`;

			const port = Number(env[vendor]!.PORT) + 450;
			env[vendor]!.PORT = String(port);
			// The Studio Referer check compares against PUBLIC_URL, so it must track the spawned port.
			env[vendor]!.PUBLIC_URL = `http://127.0.0.1:${port}`;

			instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
				cwd: paths.cwd,
				env: env[vendor],
			});

			envs[vendor] = env;
			promises.push(awaitDirectusConnection(port, instances[vendor]));
		}

		await Promise.all(promises);

		for (const vendor of supportedVendors) {
			const url = envs[vendor]![vendor]!.PUBLIC_URL!;

			const post = async (path: string, payload: Record<string, unknown>) => {
				const response = await request(url).post(path).set('Authorization', `Bearer ${adminToken}`).send(payload);
				expect(response.statusCode).toBeLessThan(300);
				return response.body.data;
			};

			const authShare = async (share: string) => {
				const response = await request(url).post('/shares/auth').send({ share });
				expect(response.statusCode).toBeLessThan(300);
				return response.body.data.access_token as string;
			};

			await common.CreateCollection(vendor, {
				collection: mainCollection,
				fields: [
					{ field: 'title', type: 'string' },
					{ field: 'sort', type: 'integer' },
				],
				meta: { sort_field: 'sort' },
				env: envs[vendor],
			});

			await common.CreateCollection(vendor, {
				collection: ignoredCollection,
				fields: [{ field: 'title', type: 'string' }],
				env: envs[vendor],
			});

			const alpha = await post(`/items/${mainCollection}`, { title: 'ds-alpha' });
			const beta = await post(`/items/${mainCollection}`, { title: 'ds-beta' });

			const role = await post('/roles', { name: 'cache-ds-role', app_access: false, admin_access: false });
			roleIds[vendor] = role.id;
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

			seeds[vendor] = {
				shareTokenAlpha: await authShare(shareAlpha.id),
				shareTokenBeta: await authShare(shareBeta.id),
			};
		}
	}, 300000);

	afterAll(async () => {
		const cleanupErrors: string[] = [];

		try {
			for (const vendor of supportedVendors) {
				const url = envs[vendor]?.[vendor]?.PUBLIC_URL;

				if (!url) {
					continue;
				}

				const del = async (path: string) => {
					try {
						const response = await request(url).delete(path).set('Authorization', `Bearer ${adminToken}`);

						if (response.statusCode !== 204) {
							cleanupErrors.push(`DELETE ${path} returned ${response.statusCode}`);
						}
					} catch (err) {
						cleanupErrors.push(`DELETE ${path} threw ${String(err)}`);
					}
				};

				await del(`/collections/${mainCollection}`);
				await del(`/collections/${ignoredCollection}`);

				const roleId = roleIds[vendor];

				if (roleId) {
					await del(`/roles/${roleId}`);
				}
			}
		} finally {
			await Promise.all(supportedVendors.map((vendor) => awaitExit(instances[vendor])));
		}

		if (cleanupErrors.length > 0) {
			throw new Error(`Cache Data Studio test cleanup failed: ${cleanupErrors.join(', ')}`);
		}
	});

	const urlOf = (vendor: string) => envs[vendor]![vendor]!.PUBLIC_URL!;
	const studioReferer = (vendor: string) => `${urlOf(vendor)}/admin/content`;

	async function clearCache(vendor: string) {
		const response = await request(urlOf(vendor))
			.post('/utils/cache/clear')
			.set('Authorization', `Bearer ${adminToken}`);

		expect(response.statusCode).toBe(200);
	}

	const studioGet = (vendor: string, path: string, token = adminToken) =>
		request(urlOf(vendor)).get(path).set('Authorization', `Bearer ${token}`).set('Referer', studioReferer(vendor));

	const write = (vendor: string, path: string, payload: Record<string, unknown>) =>
		request(urlOf(vendor)).post(path).set('Authorization', `Bearer ${adminToken}`).send(payload);

	async function primeMain(vendor: string) {
		await clearCache(vendor);

		const miss = await studioGet(vendor, `/items/${mainCollection}`);
		expect(miss.statusCode).toBe(200);
		expect(miss.headers[cacheStatusHeader]).toBe('MISS');

		const hit = await studioGet(vendor, `/items/${mainCollection}`);
		expect(hit.statusCode).toBe(200);
		expect(hit.headers[cacheStatusHeader]).toBe('HIT');
	}

	it.each(supportedVendors)('%s caches a Data Studio read as MISS then HIT', async (vendor) => {
		await primeMain(vendor);
	});

	it.each(supportedVendors)('%s purges the Data Studio read after a write to the same collection', async (vendor) => {
		await primeMain(vendor);

		const created = await write(vendor, `/items/${mainCollection}`, { title: 'ds-new' });
		expect(created.statusCode).toBeLessThan(300);

		const after = await studioGet(vendor, `/items/${mainCollection}`);
		expect(after.statusCode).toBe(200);
		expect(after.headers[cacheStatusHeader]).toBe('MISS');
	});

	it.each(supportedVendors)('%s never caches a Data Studio read of an ignored collection', async (vendor) => {
		await clearCache(vendor);

		const first = await studioGet(vendor, `/items/${ignoredCollection}`);
		expect(first.statusCode).toBe(200);
		expect(first.headers[cacheStatusHeader]).toBe('MISS');

		const second = await studioGet(vendor, `/items/${ignoredCollection}`);
		expect(second.statusCode).toBe(200);
		expect(second.headers[cacheStatusHeader]).toBe('MISS');
	});

	it.each(supportedVendors)('%s keeps a primed read when an ignored collection is written', async (vendor) => {
		await primeMain(vendor);

		const created = await write(vendor, `/items/${ignoredCollection}`, { title: 'ds-ignored' });
		expect(created.statusCode).toBeLessThan(300);

		const after = await studioGet(vendor, `/items/${mainCollection}`);
		expect(after.statusCode).toBe(200);
		expect(after.headers[cacheStatusHeader]).toBe('HIT');
	});

	it.each(supportedVendors)('%s keeps a primed read when last_page is tracked', async (vendor) => {
		await primeMain(vendor);

		const tracked = await request(urlOf(vendor))
			.patch('/users/me/track/page')
			.set('Authorization', `Bearer ${adminToken}`)
			.send({ last_page: '/content' });

		expect(tracked.statusCode).toBeLessThan(300);

		const after = await studioGet(vendor, `/items/${mainCollection}`);
		expect(after.statusCode).toBe(200);
		expect(after.headers[cacheStatusHeader]).toBe('HIT');
	});

	it.each(supportedVendors)('%s purges the read after a manual sort', async (vendor) => {
		await primeMain(vendor);

		const rows = await request(urlOf(vendor))
			.get(`/items/${mainCollection}`)
			.query({ fields: 'id', sort: 'id', limit: 2 })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(rows.statusCode).toBe(200);
		const ids = rows.body.data.map((row: { id: number }) => row.id);
		expect(ids).toHaveLength(2);

		const sorted = await request(urlOf(vendor))
			.post(`/utils/sort/${mainCollection}`)
			.set('Authorization', `Bearer ${adminToken}`)
			.send({ item: ids[0], to: ids[1] });

		expect(sorted.statusCode).toBe(200);

		const after = await studioGet(vendor, `/items/${mainCollection}`);
		expect(after.statusCode).toBe(200);
		expect(after.headers[cacheStatusHeader]).toBe('MISS');
	});

	it.each(supportedVendors)('%s segregates Data Studio caches per accountability', async (vendor) => {
		const seed = seeds[vendor]!;
		await clearCache(vendor);

		const aFirst = await studioGet(vendor, `/items/${mainCollection}`, seed.shareTokenAlpha);
		expect(aFirst.statusCode).toBe(200);
		expect(aFirst.headers[cacheStatusHeader]).toBe('MISS');
		const aBody = JSON.stringify(aFirst.body.data);
		expect(aBody).toContain('ds-alpha');
		expect(aBody).not.toContain('ds-beta');

		const aRepeat = await studioGet(vendor, `/items/${mainCollection}`, seed.shareTokenAlpha);
		expect(aRepeat.statusCode).toBe(200);
		expect(aRepeat.headers[cacheStatusHeader]).toBe('HIT');

		const bFirst = await studioGet(vendor, `/items/${mainCollection}`, seed.shareTokenBeta);
		expect(bFirst.statusCode).toBe(200);
		expect(bFirst.headers[cacheStatusHeader]).toBe('MISS');
		const bBody = JSON.stringify(bFirst.body.data);
		expect(bBody).toContain('ds-beta');
		expect(bBody).not.toContain('ds-alpha');
	});
});
