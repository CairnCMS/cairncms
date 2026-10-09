import { describe, expect } from 'vitest';
import type { Test } from 'supertest';
import type { Api } from '../../fixtures/environment';
import { describeForVendors } from '../../fixtures/applicability';
import { identityTest as test } from '../../fixtures/identities';
import { CreateCollection } from '../../fixtures/data';
import * as common from '../../fixtures/data';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminAuth = (req: Test) => req.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

const collection = 'test_apply_failure_foreign_keys';

async function deleteResource(api: Api, path: string) {
	const res = await adminAuth(request(api.url).delete(path));
	expect([204, 403, 404]).toContain(res.statusCode);
}

async function failSchemaApply(api: Api, target: string) {
	const snapshot = await adminAuth(request(api.url).get('/schema/snapshot'));
	expect(snapshot.statusCode).toBe(200);

	const desired = snapshot.body.data;
	const code = desired.fields.find((entry: any) => entry.collection === target && entry.field === 'code');
	code.schema.is_unique = true;

	const diff = await adminAuth(
		request(api.url).post('/schema/diff').send(desired).set('Content-type', 'application/json')
	);

	expect(diff.statusCode).toBe(200);

	const apply = await adminAuth(
		request(api.url).post('/schema/apply').send(diff.body.data).set('Content-type', 'application/json')
	);

	expect(apply.statusCode).toBeGreaterThanOrEqual(400);
}

describeForVendors(
	'A schema apply that fails',
	['sqlite3'],
	'Only SQLite switches foreign-key enforcement off for a schema apply.',
	() => {
		describe.each([
			['after a failed schema apply', 'failed', true],
			['without a schema apply', 'control', false],
		])('deleting a role %s', (_label, suffix, failFirst) => {
			test('removes its shares', async ({ api }) => {
				const target = `${collection}_${suffix}`;

				await deleteResource(api, `/collections/${target}`);

				const role = await adminAuth(
					request(api.url)
						.post('/roles')
						.send({ name: `apply-failure-${suffix}`, app_access: false, admin_access: false })
				);

				expect(role.statusCode).toBe(200);

				try {
					await CreateCollection(api, { collection: target, fields: [{ field: 'code', type: 'string' }] });

					for (const code of ['duplicate', 'duplicate']) {
						expect((await adminAuth(request(api.url).post(`/items/${target}`).send({ code }))).statusCode).toBe(200);
					}

					const share = await adminAuth(
						request(api.url)
							.post('/shares')
							.send({ collection: target, item: '1', role: role.body.data.id, name: target })
					);

					expect(share.statusCode).toBe(200);

					if (failFirst) await failSchemaApply(api, target);

					const removed = await adminAuth(request(api.url).delete(`/roles/${role.body.data.id}`));
					expect(removed.statusCode).toBe(204);

					expect(await api.database('directus_shares').where({ id: share.body.data.id })).toEqual([]);
				} finally {
					await deleteResource(api, `/collections/${target}`);
					await deleteResource(api, `/roles/${role.body.data.id}`);
				}
			});
		});
	}
);
