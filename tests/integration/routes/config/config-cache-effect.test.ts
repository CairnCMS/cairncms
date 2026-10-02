import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createScenarioTest } from '../../fixtures/scenario';
import { CreateCollection } from '../../fixtures/schema';
import { describeForVendors } from '../../fixtures/applicability';
import { cloneDeep } from 'lodash';
import request from '../../fixtures/request';
import * as common from '../../fixtures/identities';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createScenarioTest({
	environment: {
		env: { CACHE_ENABLED: 'true', CACHE_STORE: 'memory', CACHE_NAMESPACE: 'cairncms-config-cache-effect' },
	},
	prepare: async (api) => {
		await CreateCollection(api, { collection });
	},
	cleanup: async (api) => {
		const response = await request(api.url)
			.delete('/collections/' + collection)
			.auth(adminToken, { type: 'bearer' });

		if (response.statusCode >= 300) throw new Error('config-cache collection cleanup returned ' + response.statusCode);
	},
});

initializeFixtures();

const collection = 'test_config_cache_effect';
const adminToken = common.USER.ADMIN!.TOKEN;
const appToken = common.USER.APP_ACCESS!.TOKEN;

type ConfigSnapshot = {
	manifest: { version: number; resources: string[] };
	roles: Array<{ key: string }>;
	permissions: Array<{ role: string; permissions: Array<Record<string, unknown>> }>;
};

describeForVendors(
	'Config apply forced cache invalidation',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'This cache-enabled config scenario has not been validated on SQLite.',
	() => {
		async function appAccessRoleKey(api: Api): Promise<string> {
			const me = await request(api.url).get('/users/me?fields=role').set('Authorization', `Bearer ${appToken}`);

			const roleId = me.body.data.role as string;

			const role = await request(api.url)
				.get(`/roles/${roleId}?fields=key`)
				.set('Authorization', `Bearer ${adminToken}`);

			return role.body.data.key as string;
		}

		function snapshot(api: Api) {
			return request(api.url).get('/config/snapshot').set('Authorization', `Bearer ${adminToken}`);
		}

		function apply(api: Api, desired: ConfigSnapshot, destructive = false) {
			return request(api.url)
				.post(`/config/apply${destructive ? '?destructive=true' : ''}`)
				.set('Authorization', `Bearer ${adminToken}`)
				.send(desired);
		}

		function readAsApp(api: Api) {
			return request(api.url).get(`/items/${collection}`).set('Authorization', `Bearer ${appToken}`);
		}

		test('denies a cached read on the very next request after config apply revokes the grant', async ({ api }) => {
			const roleKey = await appAccessRoleKey(api);
			const baseline = (await snapshot(api)).body.data as ConfigSnapshot;

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
				const grant = await apply(api, granted);
				expect(grant.statusCode).toBe(200);

				const allowed = await readAsApp(api);
				expect(allowed.statusCode).toBe(200);

				const revoke = await apply(api, baseline, true);
				expect(revoke.statusCode).toBe(200);

				const denied = await readAsApp(api);
				expect(denied.statusCode).toBe(403);
			} finally {
				const restore = await apply(api, baseline, true);
				expect(restore.statusCode).toBe(200);
			}
		}, 120000);
	}
);
