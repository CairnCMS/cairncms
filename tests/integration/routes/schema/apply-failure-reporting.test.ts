import { cloneDeep } from 'lodash';
import type { Response, Test } from 'supertest';
import { describe, expect } from 'vitest';
import { CreateCollection, CreateField } from '../../fixtures/data';
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

async function tablePresent(api: Api, collection: string): Promise<boolean> {
	return api.database.schema.hasTable(collection);
}

async function columnPresent(api: Api, collection: string, field: string): Promise<boolean> {
	if (!(await api.database.schema.hasTable(collection))) return false;
	return api.database.schema.hasColumn(collection, field);
}

async function rowPresent(api: Api, table: string, where: Record<string, string>): Promise<boolean> {
	const row = await api.database(table).where(where).first();
	return row !== undefined;
}

function outcomeFor(operation: string, present: boolean): string {
	if (operation === 'update') return 'unknown';
	if (operation === 'create') return present ? 'applied' : 'reverted';
	return present ? 'reverted' : 'applied';
}

describeForVendors(
	'Schema apply partial-persistence reporting',
	['mysql', 'mysql5', 'maria'],
	'Only MySQL and MariaDB commit data definition changes implicitly, so an earlier create persists when a later change fails at the database.',
	() => {
		describe('a plan that creates a collection and then adds a field the database rejects', () => {
			test('reports observed state matching the database and leaves the created collection in place', async ({
				api,
				vendor,
			}) => {
				const keep = `test_partial_keep_${vendor}`;
				const fresh = `test_partial_new_${vendor}`;
				const tooLongField = 'x'.repeat(65);

				await deleteCollection(api, fresh);
				await deleteCollection(api, keep);

				try {
					await CreateCollection(api, { collection: keep });
					await CreateField(api, { collection: keep, field: 'label', type: 'string' });
					await CreateCollection(api, { collection: fresh });

					const desired = await snapshotIncluding(api, fresh);
					await deleteCollection(api, fresh);

					desired.fields.push({
						collection: keep,
						field: tooLongField,
						type: 'string',
						meta: { collection: keep, field: tooLongField, interface: 'input' },
						schema: { name: tooLongField, table: keep, data_type: 'varchar' },
					});

					const apply = await diffThenApply(api, desired);

					expect(apply.statusCode).toBe(500);
					expect(apply.body.errors?.[0]?.extensions?.code).toBe('SCHEMA_APPLY_FAILED');

					const persisted = apply.body.errors[0].extensions.persisted;
					expect(persisted).not.toBe('unknown');

					const reportedFresh = persisted.collections.find((entry: any) => entry.collection === fresh);
					expect(reportedFresh).toBeDefined();
					expect(reportedFresh.operation).toBe('create');
					expect(reportedFresh.table).toBe('applied');
					expect(await tablePresent(api, fresh)).toBe(true);

					const reportedField = persisted.fields.find(
						(entry: any) => entry.collection === keep && entry.field === tooLongField
					);

					expect(reportedField).toBeDefined();
					expect(reportedField.operation).toBe('create');
					expect(reportedField.column).toBe('reverted');
					expect(await columnPresent(api, keep, tooLongField)).toBe(false);

					for (const entry of persisted.collections) {
						expect(entry.table).toBe(outcomeFor(entry.operation, await tablePresent(api, entry.collection)));

						expect(entry.metadata).toBe(
							outcomeFor(
								entry.operation,
								await rowPresent(api, 'directus_collections', { collection: entry.collection })
							)
						);
					}

					for (const entry of persisted.fields) {
						expect(entry.column).toBe(
							outcomeFor(entry.operation, await columnPresent(api, entry.collection, entry.field))
						);

						expect(entry.metadata).toBe(
							outcomeFor(
								entry.operation,
								await rowPresent(api, 'directus_fields', { collection: entry.collection, field: entry.field })
							)
						);
					}
				} finally {
					await deleteCollection(api, fresh);
					await deleteCollection(api, keep);
				}
			});
		});
	}
);

describeForVendors(
	'Schema apply rollback reporting',
	['postgres', 'sqlite3'],
	'PostgreSQL and SQLite apply the whole schema change in one transaction, so a mid-apply failure rolls back entirely.',
	() => {
		describe('a plan that creates a collection and then adds a field the database rejects', () => {
			test('rolls the created collection and its metadata back and does not report a partial outcome', async ({
				api,
				vendor,
			}) => {
				const keep = `test_rollback_keep_${vendor}`;
				const fresh = `test_rollback_new_${vendor}`;
				const required = 'required_no_default';

				await deleteCollection(api, fresh);
				await deleteCollection(api, keep);

				try {
					await CreateCollection(api, { collection: keep });
					await CreateField(api, { collection: keep, field: 'label', type: 'string' });
					await api.database(keep).insert({ label: 'seed' });
					await CreateCollection(api, { collection: fresh });

					const desired = await snapshotIncluding(api, fresh);
					await deleteCollection(api, fresh);

					desired.fields.push({
						collection: keep,
						field: required,
						type: 'string',
						meta: { collection: keep, field: required, interface: 'input' },
						schema: { name: required, table: keep, data_type: 'varchar', is_nullable: false, default_value: null },
					});

					const apply = await diffThenApply(api, desired);

					expect(apply.statusCode).toBe(500);
					expect(apply.body.errors?.[0]?.extensions?.code).not.toBe('SCHEMA_APPLY_FAILED');

					expect(await tablePresent(api, fresh)).toBe(false);
					expect(await rowPresent(api, 'directus_collections', { collection: fresh })).toBe(false);
					expect(await columnPresent(api, keep, required)).toBe(false);
					expect(await rowPresent(api, 'directus_fields', { collection: keep, field: required })).toBe(false);
				} finally {
					await deleteCollection(api, fresh);
					await deleteCollection(api, keep);
				}
			});
		});
	}
);
