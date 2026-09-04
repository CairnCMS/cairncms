import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';
import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';

// A dedicated cache-enabled instance is spawned per server vendor. SQLite cannot share its file
// across instances, so it is skipped here; the forced-flush unit assertion covers the regression.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeFn = supportedVendors.length > 0 ? describe : describe.skip;

const collection = 'test_config_cache_effect';
const adminToken = common.USER.ADMIN!.TOKEN;
const appToken = common.USER.APP_ACCESS!.TOKEN;

type ConfigSnapshot = {
	manifest: { version: number; resources: string[] };
	roles: Array<{ key: string }>;
	permissions: Array<{ role: string; permissions: Array<Record<string, unknown>> }>;
};

describeFn('Config apply forced cache invalidation', () => {
	const instances = {} as { [vendor: string]: ChildProcess };
	const envs = {} as { [vendor: string]: Env };
	const startedVendors: string[] = [];
	const collectionCreated = new Set<string>();

	beforeAll(async () => {
		const promises = [];

		for (const vendor of supportedVendors) {
			const env = cloneDeep(config.envs);
			env[vendor].CACHE_ENABLED = 'true';
			env[vendor].CACHE_STORE = 'memory';
			env[vendor].CACHE_NAMESPACE = 'cairncms-config-cache-effect';

			const port = Number(env[vendor]!.PORT) + 175;
			env[vendor]!.PORT = String(port);

			instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
				cwd: paths.cwd,
				env: env[vendor],
			});

			envs[vendor] = env;
			startedVendors.push(vendor);
			promises.push(awaitDirectusConnection(port));
		}

		await Promise.all(promises);

		for (const vendor of supportedVendors) {
			await common.CreateCollection(vendor, { collection, env: envs[vendor] });
			collectionCreated.add(vendor);
		}
	}, 300000);

	async function stopInstance(child: ChildProcess | undefined): Promise<void> {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;

		await new Promise<void>((resolve, reject) => {
			const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
			const giveUp = setTimeout(() => reject(new Error('cache-effect instance did not exit after SIGKILL')), 15000);

			child.on('close', () => {
				clearTimeout(kill);
				clearTimeout(giveUp);
				resolve();
			});

			child.kill();
		});
	}

	afterAll(async () => {
		const failures: unknown[] = [];

		for (const vendor of startedVendors) {
			if (collectionCreated.has(vendor)) {
				try {
					const response = await request(getUrl(vendor, envs[vendor]))
						.delete(`/collections/${collection}`)
						.set('Authorization', `Bearer ${adminToken}`);

					if (response.statusCode >= 300) {
						failures.push(new Error(`collection cleanup for ${vendor} returned ${response.statusCode}`));
					}
				} catch (err) {
					failures.push(err);
				}
			}

			try {
				await stopInstance(instances[vendor]);
			} catch (err) {
				failures.push(err);
			}
		}

		if (failures.length > 0) {
			throw new Error(`cache-effect teardown failed: ${failures.map((f) => String(f)).join('; ')}`);
		}
	});

	async function appAccessRoleKey(vendor: string, env: Env): Promise<string> {
		const me = await request(getUrl(vendor, env))
			.get('/users/me?fields=role')
			.set('Authorization', `Bearer ${appToken}`);

		const roleId = me.body.data.role as string;

		const role = await request(getUrl(vendor, env))
			.get(`/roles/${roleId}?fields=key`)
			.set('Authorization', `Bearer ${adminToken}`);

		return role.body.data.key as string;
	}

	function snapshot(vendor: string, env: Env) {
		return request(getUrl(vendor, env)).get('/config/snapshot').set('Authorization', `Bearer ${adminToken}`);
	}

	function apply(vendor: string, env: Env, desired: ConfigSnapshot, destructive = false) {
		return request(getUrl(vendor, env))
			.post(`/config/apply${destructive ? '?destructive=true' : ''}`)
			.set('Authorization', `Bearer ${adminToken}`)
			.send(desired);
	}

	function readAsApp(vendor: string, env: Env) {
		return request(getUrl(vendor, env)).get(`/items/${collection}`).set('Authorization', `Bearer ${appToken}`);
	}

	it.each(supportedVendors)(
		'%s denies a cached read on the very next request after config apply revokes the grant',
		async (vendor) => {
			const env = envs[vendor]!;
			const roleKey = await appAccessRoleKey(vendor, env);
			const baseline = (await snapshot(vendor, env)).body.data as ConfigSnapshot;

			const granted = cloneDeep(baseline);
			let set = granted.permissions.find((entry) => entry.role === roleKey);

			if (!set) {
				set = { role: roleKey, permissions: [] };
				granted.permissions.push(set);
			}

			set.permissions.push({
				collection,
				action: 'read',
				permissions: {},
				validation: null,
				presets: null,
				fields: ['*'],
			});

			try {
				const grant = await apply(vendor, env, granted);
				expect(grant.statusCode).toBe(200);

				const allowed = await readAsApp(vendor, env);
				expect(allowed.statusCode).toBe(200);

				const revoke = await apply(vendor, env, baseline, true);
				expect(revoke.statusCode).toBe(200);

				const denied = await readAsApp(vendor, env);
				expect(denied.statusCode).toBe(403);
			} finally {
				const restore = await apply(vendor, env, baseline, true);
				expect(restore.statusCode).toBe(200);
			}
		},
		120000
	);
});
