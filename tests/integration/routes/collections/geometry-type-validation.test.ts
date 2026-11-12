import { cloneDeep } from 'lodash';
import type { Response } from 'supertest';
import { describe, expect, inject } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { apiTest as test, type Api } from '../../fixtures/environment';
import request, { requestGraphQL } from '../../fixtures/request';
import { vendorsOf, vendorsWith } from '../../harness/database-vendors.mjs';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const geometryVendors = [...vendorsWith('postgis'), 'mysql', 'maria'];
const geometryReason = 'Geometry columns need PostGIS on PostgreSQL. MySQL and MariaDB have native spatial types.';

const declaredGeometryTypes = [
	'geometry',
	'geometry.Point',
	'geometry.LineString',
	'geometry.Polygon',
	'geometry.MultiPoint',
	'geometry.MultiLineString',
	'geometry.MultiPolygon',
];

const undeclaredGeometryType = 'geometry.Point.extra';

const idField = {
	field: 'id',
	type: 'integer',
	meta: { hidden: true },
	schema: { is_primary_key: true, has_auto_increment: true },
};

const geometryField = (field: string, type: string) => ({ field, type, meta: { special: [type] }, schema: {} });

const fieldName = (type: string) => type.replace('.', '_').toLowerCase();

const collectionPayload = (collection: string, fields: object[] = []) => ({
	collection,
	meta: {},
	schema: {},
	fields: [idField, ...fields],
});

const asAdmin = (api: Api) => `Bearer ${api.adminToken}`;

async function removeCollection(api: Api, collection: string) {
	await request(api.url).delete(`/collections/${collection}`).set('Authorization', asAdmin(api));
	await api.database.schema.dropTableIfExists(collection);
	await api.database('directus_fields').where({ collection }).delete();
	await api.database('directus_collections').where({ collection }).delete();
}

async function createCollection(api: Api, collection: string, fields: object[] = []) {
	const response = await request(api.url)
		.post('/collections')
		.send(collectionPayload(collection, fields))
		.set('Authorization', asAdmin(api));

	expect(response.statusCode).toBe(200);
}

async function expectCollectionAbsent(api: Api, collection: string) {
	expect(await api.database.schema.hasTable(collection)).toBe(false);
	expect(await api.database('directus_collections').where({ collection })).toEqual([]);
	expect(await api.database('directus_fields').where({ collection })).toEqual([]);
}

function expectIllegalType(response: Response, type: string) {
	expect(response.statusCode).toBe(400);
	expect(response.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');
	expect(response.body.errors?.[0]?.message).toBe(`Illegal type passed: "${type}"`);
}

async function readField(api: Api, collection: string, field: string) {
	const response = await request(api.url).get(`/fields/${collection}/${field}`).set('Authorization', asAdmin(api));
	expect(response.statusCode).toBe(200);
	return response.body.data;
}

async function applySnapshotWith(api: Api, keep: string[], tamper?: (diff: any) => void) {
	const snapshot = await request(api.url).get('/schema/snapshot').set('Authorization', asAdmin(api));
	expect(snapshot.statusCode).toBe(200);

	const desired = cloneDeep(snapshot.body.data);
	for (const collection of keep) await removeCollection(api, collection);

	const diff = await request(api.url)
		.post('/schema/diff')
		.send(desired)
		.set('Content-type', 'application/json')
		.set('Authorization', asAdmin(api));

	expect(diff.statusCode).toBe(200);
	tamper?.(diff.body.data.diff);

	return request(api.url)
		.post('/schema/apply')
		.send(diff.body.data)
		.set('Content-type', 'application/json')
		.set('Authorization', asAdmin(api));
}

describeForVendors('Collection creation with an undeclared geometry type', geometryVendors, geometryReason, () => {
	test('refuses a single collection before creating it', async ({ api }) => {
		const collection = 'test_geometry_single';

		try {
			const response = await request(api.url)
				.post('/collections')
				.send(collectionPayload(collection, [geometryField('location', undeclaredGeometryType)]))
				.set('Authorization', asAdmin(api));

			expectIllegalType(response, undeclaredGeometryType);
			await expectCollectionAbsent(api, collection);
		} finally {
			await removeCollection(api, collection);
		}
	});

	test('refuses a multi-collection request before creating any of them', async ({ api }) => {
		const first = 'test_geometry_many_first';
		const second = 'test_geometry_many_second';

		try {
			const response = await request(api.url)
				.post('/collections')
				.send([
					collectionPayload(first),
					collectionPayload(second, [geometryField('location', undeclaredGeometryType)]),
				])
				.set('Authorization', asAdmin(api));

			expectIllegalType(response, undeclaredGeometryType);
			await expectCollectionAbsent(api, first);
			await expectCollectionAbsent(api, second);
		} finally {
			await removeCollection(api, first);
			await removeCollection(api, second);
		}
	});
});

describe('Multi-collection creation with an undeclared type', () => {
	test('refuses before creating any of the collections', async ({ api }) => {
		const first = 'test_type_many_first';
		const second = 'test_type_many_second';

		try {
			const response = await request(api.url)
				.post('/collections')
				.send([
					collectionPayload(first),
					collectionPayload(second, [{ field: 'value', type: 'wibble', meta: {}, schema: {} }]),
				])
				.set('Authorization', asAdmin(api));

			expectIllegalType(response, 'wibble');
			await expectCollectionAbsent(api, first);
			await expectCollectionAbsent(api, second);
		} finally {
			await removeCollection(api, first);
			await removeCollection(api, second);
		}
	});
});

describeForVendors('GraphQL schema changes with an undeclared geometry type', geometryVendors, geometryReason, () => {
	test('refuses to create a collection', async ({ api }) => {
		const collection = 'test_geometry_gql_collection';

		try {
			const response = await requestGraphQL(api.url, true, api.adminToken, {
				mutation: {
					create_collections_item: {
						__args: {
							data: {
								collection,
								schema: { name: collection },
								fields: [
									{ field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } },
									{ field: 'location', type: undeclaredGeometryType },
								],
							},
						},
						collection: true,
					},
				},
			});

			expect(response.body.data?.create_collections_item ?? null).toBeNull();
			expect(response.body.errors).toHaveLength(1);
			await expectCollectionAbsent(api, collection);
		} finally {
			await removeCollection(api, collection);
		}
	});

	test('refuses to create a field', async ({ api }) => {
		const collection = 'test_geometry_gql_field';

		try {
			await createCollection(api, collection);

			const response = await requestGraphQL(api.url, true, api.adminToken, {
				mutation: {
					create_fields_item: {
						__args: { collection, data: { field: 'location', type: undeclaredGeometryType } },
						field: true,
					},
				},
			});

			expect(response.body.data?.create_fields_item ?? null).toBeNull();
			expect(response.body.errors).toHaveLength(1);
			expect(await api.database.schema.hasColumn(collection, 'location')).toBe(false);
			expect(await api.database('directus_fields').where({ collection, field: 'location' })).toEqual([]);
		} finally {
			await removeCollection(api, collection);
		}
	});

	test('refuses to change a column through a field update', async ({ api }) => {
		const collection = 'test_geometry_gql_update';

		try {
			await createCollection(api, collection, [geometryField('location', 'geometry.Point')]);
			expect((await readField(api, collection, 'location')).schema.is_nullable).toBe(true);

			const response = await requestGraphQL(api.url, true, api.adminToken, {
				mutation: {
					update_fields_item: {
						__args: {
							collection,
							field: 'location',
							data: { type: undeclaredGeometryType, schema: { is_nullable: false } },
						},
						field: true,
					},
				},
			});

			expect(response.body.data?.update_fields_item ?? null).toBeNull();
			expect(response.body.errors).toHaveLength(1);

			const field = await readField(api, collection, 'location');
			expect(field.type).toBe('geometry.Point');
			expect(field.schema.is_nullable).toBe(true);
		} finally {
			await removeCollection(api, collection);
		}
	});
});

describeForVendors('Schema apply with an undeclared geometry type', geometryVendors, geometryReason, () => {
	test('refuses before creating any collection in the plan', async ({ api }) => {
		const first = 'test_geometry_apply_first';
		const second = 'test_geometry_apply_second';

		try {
			await createCollection(api, first);
			await createCollection(api, second, [geometryField('location', 'geometry.Point')]);

			const apply = await applySnapshotWith(api, [first, second], (diff) => {
				const entry = diff.fields.find((change: any) => change.collection === second && change.field === 'location');
				expect(entry?.diff?.[0]?.kind).toBe('N');
				entry.diff[0].rhs.type = undeclaredGeometryType;
			});

			expectIllegalType(apply, undeclaredGeometryType);
			await expectCollectionAbsent(api, first);
			await expectCollectionAbsent(api, second);
		} finally {
			await removeCollection(api, first);
			await removeCollection(api, second);
		}
	});
});

describeForVendors('Declared geometry types', geometryVendors, geometryReason, () => {
	const fields = declaredGeometryTypes.map((type) => geometryField(fieldName(type), type));

	async function physicalGeometryType(api: Api, collection: string, field: string) {
		if (vendorsOf('postgres').includes(inject('integration').vendor)) {
			const column = await api.database
				.select('type')
				.from('geometry_columns')
				.where({ f_table_name: collection, f_geometry_column: field })
				.first();

			return String(column?.type).toLowerCase();
		}

		return String((await readField(api, collection, field)).schema.data_type).toLowerCase();
	}

	async function expectDeclaredColumns(api: Api, collection: string) {
		for (const type of declaredGeometryTypes) {
			expect(await api.database.schema.hasColumn(collection, fieldName(type))).toBe(true);
			expect((await readField(api, collection, fieldName(type))).type).toBe(type);

			expect(await physicalGeometryType(api, collection, fieldName(type))).toBe(
				(type.split('.')[1] ?? 'geometry').toLowerCase()
			);
		}
	}

	test('create every column through collection creation', async ({ api }) => {
		const collection = 'test_geometry_declared_collection';

		try {
			await createCollection(api, collection, fields);
			await expectDeclaredColumns(api, collection);
		} finally {
			await removeCollection(api, collection);
		}
	});

	test('create every column through field creation', async ({ api }) => {
		const collection = 'test_geometry_declared_fields';

		try {
			await createCollection(api, collection);

			for (const field of fields) {
				const response = await request(api.url)
					.post(`/fields/${collection}`)
					.send(field)
					.set('Authorization', asAdmin(api));

				expect(response.statusCode).toBe(200);
			}

			await expectDeclaredColumns(api, collection);
		} finally {
			await removeCollection(api, collection);
		}
	});

	test('create every column through schema apply', async ({ api }) => {
		const collection = 'test_geometry_declared_apply';

		try {
			await createCollection(api, collection, fields);

			const apply = await applySnapshotWith(api, [collection]);

			expect(apply.statusCode).toBe(204);
			await expectDeclaredColumns(api, collection);
		} finally {
			await removeCollection(api, collection);
		}
	});
});

describeForVendors('Stored geometry metadata outside the declared types', geometryVendors, geometryReason, () => {
	test('keeps reads, item writes, and metadata-only updates working without rewriting it', async ({ api }) => {
		const collection = 'test_geometry_stored_metadata';

		const storedSpecial = async () =>
			(await api.database('directus_fields').where({ collection, field: 'location' }).first('special'))?.special;

		try {
			await createCollection(api, collection, [geometryField('location', 'geometry.Point')]);

			const relabel = await request(api.url)
				.patch(`/fields/${collection}/location`)
				.send({ meta: { special: ['geometry.point'] } })
				.set('Authorization', asAdmin(api));

			expect(relabel.statusCode).toBe(200);
			const stored = await storedSpecial();
			expect(String(stored)).toContain('geometry.point');

			expect((await readField(api, collection, 'location')).type).toBe('geometry.point');

			const created = await request(api.url)
				.post(`/items/${collection}`)
				.send({ location: { type: 'Point', coordinates: [1, 2] } })
				.set('Authorization', asAdmin(api));

			expect(created.statusCode).toBe(200);

			const item = await request(api.url)
				.get(`/items/${collection}/${created.body.data.id}`)
				.set('Authorization', asAdmin(api));

			expect(item.statusCode).toBe(200);
			expect(item.body.data.location).toMatchObject({ type: 'Point', coordinates: [1, 2] });

			const note = await request(api.url)
				.patch(`/fields/${collection}/location`)
				.send({ meta: { note: 'Checked' } })
				.set('Authorization', asAdmin(api));

			expect(note.statusCode).toBe(200);
			expect(await storedSpecial()).toEqual(stored);
		} finally {
			await removeCollection(api, collection);
		}
	});
});

describeForVendors(
	'Declared geometry types on SQLite',
	['sqlite'],
	'SQLite has no spatial types without SpatiaLite, so only acceptance of the declared types is checked.',
	() => {
		test('are accepted by collection creation', async ({ api }) => {
			const collection = 'test_geometry_declared_sqlite';

			try {
				await createCollection(
					api,
					collection,
					declaredGeometryTypes.map((type) => geometryField(fieldName(type), type))
				);

				for (const type of declaredGeometryTypes) {
					expect(await api.database.schema.hasColumn(collection, fieldName(type))).toBe(true);
				}
			} finally {
				await removeCollection(api, collection);
			}
		});
	}
);
