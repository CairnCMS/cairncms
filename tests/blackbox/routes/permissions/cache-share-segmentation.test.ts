import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';

// The response cache is exercised on a dedicated instance with caching enabled. SQLite cannot
// safely share a single file across the default and spawned instances.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeFn = supportedVendors.length > 0 ? describe : describe.skip;

const collection = 'test_cache_share_seg';
const cacheStatusHeader = 'x-cache-status';
const adminToken = common.USER.ADMIN.TOKEN;

type Seed = {
	itemsShareToken: string; // share scoped to the alpha item
	otherShareToken: string; // share scoped to the beta item, same role
	meShareA: string; // share id A (same scope/role as B)
	meShareB: string; // share id B
	meTokenA: string;
	meTokenB: string;
};

describeFn('Response cache authorization segmentation', () => {
	const instances = {} as { [vendor: string]: ChildProcess };
	const envs = {} as { [vendor: string]: Env };
	const seeds = {} as { [vendor: string]: Seed };

	beforeAll(async () => {
		const promises = [];

		for (const vendor of supportedVendors) {
			const env = cloneDeep(config.envs);
			env[vendor].CACHE_ENABLED = 'true';
			env[vendor].CACHE_AUTO_PURGE = 'false';
			env[vendor].CACHE_STORE = 'memory';
			env[vendor].CACHE_STATUS_HEADER = cacheStatusHeader;
			env[vendor].CACHE_NAMESPACE = 'cairncms-cache-share-seg';

			const port = Number(env[vendor]!.PORT) + 400;
			env[vendor]!.PORT = String(port);

			instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
				cwd: paths.cwd,
				env: env[vendor],
			});

			envs[vendor] = env;
			promises.push(awaitDirectusConnection(port));
		}

		await Promise.all(promises);

		// Seed each spawned instance directly (it owns the schema + permission state it will serve).
		for (const vendor of supportedVendors) {
			const url = getUrl(vendor, envs[vendor]);

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
				collection,
				fields: [{ field: 'title', type: 'string' }],
				env: envs[vendor],
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

			seeds[vendor] = {
				itemsShareToken: await authShare(shareAlpha.id),
				otherShareToken: await authShare(shareBeta.id),
				meShareA: shareMeA.id,
				meShareB: shareMeB.id,
				meTokenA: await authShare(shareMeA.id),
				meTokenB: await authShare(shareMeB.id),
			};
		}
	}, 300000);

	afterAll(() => {
		for (const vendor of supportedVendors) {
			instances[vendor]!.kill();
		}
	});

	describe('read-data surface: /items caches per share and never serves one share the other content', () => {
		it.each(supportedVendors)('%s', async (vendor) => {
			const url = getUrl(vendor, envs[vendor]!);
			const seed = seeds[vendor]!;

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
		it.each(supportedVendors)('%s', async (vendor) => {
			const url = getUrl(vendor, envs[vendor]!);
			const seed = seeds[vendor]!;

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
});
