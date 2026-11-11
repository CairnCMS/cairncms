import { randomUUID } from 'node:crypto';
import { describe, expect } from 'vitest';
import { createApiTest } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const QUERY_LIMIT_DEFAULT = 2;
const PERMISSION_ACTIONS = ['read', 'update', 'delete'];
const DEPENDANTS = PERMISSION_ACTIONS.length;

const test = createApiTest({ env: { QUERY_LIMIT_DEFAULT: String(QUERY_LIMIT_DEFAULT) } });

initializeFixtures();

describe('Role deletion with more dependants than the query default', () => {
	test('removes every permission and preset, and suspends and unassigns every user', async ({ api }) => {
		const admin = `Bearer ${api.adminToken}`;
		const marker = randomUUID().slice(0, 8);

		const role = await setupRequest(api.url)
			.post('/roles')
			.send({ name: `Cleanup ${marker}`, admin_access: false })
			.set('Authorization', admin);

		const roleId = role.body.data.id as string;
		const users: string[] = [];

		try {
			for (let index = 0; index < DEPENDANTS; index++) {
				const user = await setupRequest(api.url)
					.post('/users')
					.send({ email: `cleanup-${marker}-${index}@tests.com`, password: 'CleanupPassword1', role: roleId })
					.set('Authorization', admin);

				users.push(user.body.data.id);

				await setupRequest(api.url)
					.post('/permissions')
					.send({ role: roleId, collection: 'directus_files', action: PERMISSION_ACTIONS[index], fields: ['*'] })
					.set('Authorization', admin);

				await setupRequest(api.url)
					.post('/presets')
					.send({ role: roleId, collection: 'directus_files', bookmark: `Cleanup ${marker} ${index}` })
					.set('Authorization', admin);
			}

			const response = await request(api.url).delete(`/roles/${roleId}`).set('Authorization', admin);

			expect(response.statusCode).toBe(204);
			expect(await api.database('directus_roles').where({ id: roleId }).first()).toBeUndefined();
			expect(await api.database('directus_permissions').where({ role: roleId })).toEqual([]);
			expect(await api.database('directus_presets').where({ role: roleId })).toEqual([]);

			const remaining = await api.database('directus_users').whereIn('id', users).select('status', 'role');
			expect(remaining).toHaveLength(DEPENDANTS);

			for (const user of remaining) {
				expect(user).toEqual({ status: 'suspended', role: null });
			}
		} finally {
			for (const id of users) await request(api.url).delete(`/users/${id}`).set('Authorization', admin);
			await api.database('directus_permissions').where({ role: roleId }).delete();
			await api.database('directus_presets').where({ role: roleId }).delete();
			await request(api.url).delete(`/roles/${roleId}`).set('Authorization', admin);
		}
	});
});
