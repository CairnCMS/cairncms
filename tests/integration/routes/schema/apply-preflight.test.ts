import { cloneDeep } from 'lodash';
import type { Response, Test } from 'supertest';
import { describe, expect } from 'vitest';
import { CreateCollection, CreateField, CreateRelation } from '../../fixtures/data';
import * as common from '../../fixtures/data';
import { describeForVendors } from '../../fixtures/applicability';
import type { Api } from '../../fixtures/environment';
import { identityTest as test } from '../../fixtures/identities';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminAuth = (req: Test) => req.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

async function deleteCollection(api: Api, collection: string) {
	const res = await adminAuth(request(api.url).delete(`/collections/${collection}`));
	expect([204, 403, 404]).toContain(res.statusCode);
}

async function snapshotIncluding(api: Api, present: string) {
	const res = await adminAuth(setupRequest(api.url).get('/schema/snapshot'));
	expect(res.statusCode).toBe(200);
	expect(res.body.data.collections.some((entry: any) => entry.collection === present)).toBe(true);
	return cloneDeep(res.body.data);
}

async function diffThenApply(api: Api, desired: object): Promise<Response> {
	const diff = await adminAuth(
		setupRequest(api.url).post('/schema/diff').send(desired).set('Content-type', 'application/json')
	);

	expect(diff.statusCode).toBe(200);

	return adminAuth(request(api.url).post('/schema/apply').send(diff.body.data).set('Content-type', 'application/json'));
}

function expectRefused(apply: Response, message: string) {
	expect(apply.statusCode).toBe(400);
	expect(apply.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');
	expect(apply.body.errors?.[0]?.message).toContain(message);
}

async function expectCollectionAbsent(api: Api, collection: string) {
	expect(await api.database.schema.hasTable(collection)).toBe(false);
	expect(await api.database('directus_collections').where({ collection })).toEqual([]);
	expect(await api.database('directus_fields').where({ collection })).toEqual([]);
}

describeForVendors(
	'Schema apply preflight',
	['mysql', 'mysql5', 'maria'],
	'Only MySQL and MariaDB commit data definition changes implicitly, so an earlier create can persist ahead of a later refusal.',
	() => {
		describe('a plan that creates a collection and then converts an existing field to an alias', () => {
			test('is refused before the new collection is created', async ({ api, vendor }) => {
				const existing = `test_preflight_alias_keep_${vendor}`;
				const fresh = `test_preflight_alias_new_${vendor}`;

				await deleteCollection(api, fresh);
				await deleteCollection(api, existing);

				try {
					await CreateCollection(api, { collection: existing });
					await CreateField(api, { collection: existing, field: 'label', type: 'string' });
					await CreateCollection(api, { collection: fresh });

					const desired = await snapshotIncluding(api, fresh);
					await deleteCollection(api, fresh);

					const label = desired.fields.find((entry: any) => entry.collection === existing && entry.field === 'label');
					label.type = 'alias';

					expectRefused(await diffThenApply(api, desired), 'Alias type cannot be changed');
					await expectCollectionAbsent(api, fresh);
				} finally {
					await deleteCollection(api, fresh);
					await deleteCollection(api, existing);
				}
			});
		});

		describe('a plan that creates a collection and then adds a relation to a missing collection', () => {
			test('is refused before the new collection is created', async ({ api, vendor }) => {
				const existing = `test_preflight_target_keep_${vendor}`;
				const fresh = `test_preflight_target_new_${vendor}`;
				const missing = `test_preflight_ghost_${vendor}`;

				await deleteCollection(api, fresh);
				await deleteCollection(api, existing);

				try {
					await CreateCollection(api, { collection: existing });
					await CreateField(api, { collection: existing, field: 'ref', type: 'integer' });
					await CreateCollection(api, { collection: fresh });

					const desired = await snapshotIncluding(api, fresh);
					await deleteCollection(api, fresh);

					desired.relations.push({
						collection: existing,
						field: 'ref',
						related_collection: missing,
						meta: {},
						schema: null,
					});

					expectRefused(await diffThenApply(api, desired), `Collection "${missing}" doesn't exist`);
					await expectCollectionAbsent(api, fresh);
				} finally {
					await deleteCollection(api, fresh);
					await deleteCollection(api, existing);
				}
			});
		});

		describe('a diff that creates a collection and then adds a field of an illegal type', () => {
			test('is refused before the new collection is created', async ({ api, vendor }) => {
				const existing = `test_preflight_type_keep_${vendor}`;
				const fresh = `test_preflight_type_new_${vendor}`;

				await deleteCollection(api, fresh);
				await deleteCollection(api, existing);

				try {
					await CreateCollection(api, { collection: existing });
					await CreateCollection(api, { collection: fresh });

					const desired = await snapshotIncluding(api, fresh);
					await deleteCollection(api, fresh);

					desired.fields.push({
						collection: existing,
						field: 'bad',
						type: 'string',
						meta: { collection: existing, field: 'bad', interface: 'input' },
						schema: { name: 'bad', table: existing, data_type: 'varchar' },
					});

					const diff = await adminAuth(
						setupRequest(api.url).post('/schema/diff').send(desired).set('Content-type', 'application/json')
					);

					expect(diff.statusCode).toBe(200);

					// The diff endpoint validates raw types, so tamper the later field after it, then apply directly.
					const entry = diff.body.data.diff.fields.find((f: any) => f.collection === existing && f.field === 'bad');
					expect(entry?.diff?.[0]?.kind).toBe('N');
					entry.diff[0].rhs.type = 'wibble';

					const apply = await adminAuth(
						request(api.url).post('/schema/apply').send(diff.body.data).set('Content-type', 'application/json')
					);

					expectRefused(apply, 'Illegal type passed: "wibble"');
					await expectCollectionAbsent(api, fresh);
					expect(await api.database('directus_fields').where({ collection: existing, field: 'bad' })).toEqual([]);
				} finally {
					await deleteCollection(api, fresh);
					await deleteCollection(api, existing);
				}
			});
		});

		describe('a plan that creates a collection, a field, and a relation together with every change valid', () => {
			test('applies fully', async ({ api, vendor }) => {
				const existing = `test_preflight_ok_keep_${vendor}`;
				const fresh = `test_preflight_ok_new_${vendor}`;

				await deleteCollection(api, fresh);
				await deleteCollection(api, existing);

				try {
					await CreateCollection(api, { collection: existing });
					await CreateCollection(api, { collection: fresh });
					await CreateField(api, { collection: fresh, field: 'owner', type: 'integer' });
					await CreateRelation(api, { collection: fresh, field: 'owner', related_collection: existing });

					const desired = await snapshotIncluding(api, fresh);
					await deleteCollection(api, fresh);

					const apply = await diffThenApply(api, desired);
					expect(apply.statusCode).toBe(204);

					expect(await api.database.schema.hasTable(fresh)).toBe(true);
					expect(await api.database('directus_collections').where({ collection: fresh })).toHaveLength(1);

					expect(
						await api.database('directus_relations').where({ many_collection: fresh, many_field: 'owner' })
					).toHaveLength(1);
				} finally {
					await deleteCollection(api, fresh);
					await deleteCollection(api, existing);
				}
			});
		});
	}
);
