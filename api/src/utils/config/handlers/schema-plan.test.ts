import { describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import type { CollectionMeta } from '../../../types/collection.js';
import type { ConfigSchemaCollection } from '../../../types/config.js';
import type { SnapshotField, SnapshotRelation } from '../../../types/index.js';
import { computeSchemaPlan, schemaDescriptor } from './schema.js';

function collectionMeta(collection: string, overrides: Partial<CollectionMeta> = {}): CollectionMeta {
	return {
		collection,
		note: null,
		hidden: false,
		singleton: false,
		icon: null,
		translations: {},
		item_duplication_fields: null,
		accountability: 'all',
		group: null,
		...overrides,
	};
}

function makeField(collection: string, field: string, overrides: Record<string, unknown> = {}): SnapshotField {
	return {
		collection,
		field,
		type: 'string',
		meta: {},
		schema: { name: field },
		...overrides,
	} as unknown as SnapshotField;
}

function makeRelation(
	collection: string,
	field: string,
	related: string,
	overrides: Record<string, unknown> = {}
): SnapshotRelation {
	return {
		collection,
		field,
		related_collection: related,
		meta: {},
		schema: {},
		...overrides,
	} as unknown as SnapshotRelation;
}

function fieldObject(props: Record<string, unknown>): SnapshotField {
	return props as unknown as SnapshotField;
}

function systemRecord(collection: string, fields: SnapshotField[]): ConfigSchemaCollection {
	return { collection, fields, relations: [] };
}

function record(collection: string, overrides: Partial<ConfigSchemaCollection> = {}): ConfigSchemaCollection {
	return {
		collection,
		meta: {} as Exclude<ConfigSchemaCollection['meta'], undefined>,
		schema: { name: collection } as Exclude<ConfigSchemaCollection['schema'], undefined>,
		fields: [],
		relations: [],
		...overrides,
	};
}

function storedFieldsOf(records: ConfigSchemaCollection[]): SnapshotField[] {
	return records.flatMap((entry) => entry.fields);
}

function plan(current: ConfigSchemaCollection[], desired: ConfigSchemaCollection[]) {
	return computeSchemaPlan(current, desired, storedFieldsOf(current));
}

describe('computeSchemaPlan', () => {
	it('fans a created collection into collection, field, and relation creates', () => {
		const desired = [
			record('articles', {
				fields: [makeField('articles', 'title'), makeField('articles', 'body')],
				relations: [makeRelation('articles', 'author', 'directus_users')],
			}),
		];

		const result = plan([], desired);

		expect(result.update).toEqual([]);
		expect(result.delete).toEqual([]);

		expect(result.create.filter((entry) => entry.changeKind === 'collections').map((entry) => entry.identity)).toEqual([
			{ collection: 'articles' },
		]);

		expect(result.create.filter((entry) => entry.changeKind === 'fields').map((entry) => entry.identity)).toEqual([
			{ collection: 'articles', field: 'title' },
			{ collection: 'articles', field: 'body' },
		]);

		const relations = result.create.filter((entry) => entry.changeKind === 'relations');
		expect(relations.map((entry) => entry.identity)).toEqual([{ collection: 'articles', field: 'author' }]);
		expect(relations[0]).toMatchObject({ relatedCollection: 'directus_users' });
	});

	it('emits an empty plan when the current and desired trees match', () => {
		const tree = [
			record('articles', {
				fields: [makeField('articles', 'title')],
				relations: [makeRelation('articles', 'author', 'directus_users')],
			}),
		];

		const result = plan(tree, structuredClone(tree));

		expect(result).toEqual({ create: [], update: [], delete: [] });
	});

	it('records a relation retarget as an update carrying the related_collection change', () => {
		const current = [
			record('articles', {
				fields: [makeField('articles', 'author', { type: 'uuid' })],
				relations: [makeRelation('articles', 'author', 'directus_users')],
			}),
		];

		const desired = [
			record('articles', {
				fields: [makeField('articles', 'author', { type: 'uuid' })],
				relations: [makeRelation('articles', 'author', 'authors')],
			}),
		];

		const result = plan(current, desired);

		expect(result.create).toEqual([]);
		expect(result.delete).toEqual([]);
		expect(result.update).toHaveLength(1);

		const [entry] = result.update;

		expect(entry).toMatchObject({
			changeKind: 'relations',
			identity: { collection: 'articles', field: 'author' },
			relatedCollection: 'authors',
		});

		expect(entry!.changes['related_collection']).toEqual({ before: 'directus_users', after: 'authors' });
	});

	it('drops an operator field from a system collection without dropping the collection', () => {
		const current = [
			systemRecord('directus_users', [makeField('directus_users', 'nickname'), makeField('directus_users', 'legacy')]),
		];

		const desired = [systemRecord('directus_users', [makeField('directus_users', 'nickname')])];

		const result = plan(current, desired);

		expect(result.create).toEqual([]);
		expect(result.update).toEqual([]);

		expect(result.delete).toEqual([
			expect.objectContaining({ changeKind: 'fields', identity: { collection: 'directus_users', field: 'legacy' } }),
		]);
	});

	it('refuses to plan without the retained current schema fields', () => {
		expect(() => computeSchemaPlan([], [record('articles')], undefined)).toThrow(
			'Schema planning requires the retained current schema fields'
		);
	});

	it('aligns folder references using the retained stored fields', () => {
		const coverCurrent = fieldObject({
			collection: 'media',
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'file', options: { folder: 'folder-key' } },
			schema: { name: 'cover' },
		});

		const coverStored = fieldObject({
			collection: 'media',
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'file', options: { folder: 'folder-id' } },
			schema: { name: 'cover' },
		});

		const coverDesired = fieldObject({
			collection: 'media',
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'custom-interface', options: { folder: 'folder-id' } },
			schema: { name: 'cover' },
		});

		const result = computeSchemaPlan(
			[record('media', { fields: [coverCurrent] })],
			[record('media', { fields: [coverDesired] })],
			[coverStored]
		);

		const update = result.update.find((entry) => entry.changeKind === 'fields');
		const meta = update!.changes['meta'] as { before: Record<string, any>; after: Record<string, any> };

		expect(meta.before['options'].folder).toBe('folder-id');
		expect(meta.after['options'].folder).toBe('folder-id');
		expect(meta.before['interface']).toBe('file');
		expect(meta.after['interface']).toBe('custom-interface');
	});

	it('reports a primary-key metadata edit without the schema change the diff engine ignores', () => {
		const idCurrent = fieldObject({
			collection: 'articles',
			field: 'id',
			type: 'integer',
			meta: { note: 'old' },
			schema: { name: 'id', is_primary_key: true, has_auto_increment: true, data_type: 'integer' },
		});

		const idDesired = fieldObject({
			collection: 'articles',
			field: 'id',
			type: 'integer',
			meta: { note: 'new' },
			schema: { name: 'id', is_primary_key: true, has_auto_increment: true, data_type: 'serial' },
		});

		const result = computeSchemaPlan(
			[record('articles', { fields: [idCurrent] })],
			[record('articles', { fields: [idDesired] })],
			[idCurrent]
		);

		const update = result.update.find((entry) => entry.changeKind === 'fields');

		expect(Object.keys(update!.changes)).toEqual(['meta']);
	});
});

describe('computeSchemaPlan attribute presence', () => {
	function fieldUpdate(currentField: SnapshotField, desiredField: SnapshotField) {
		const current = [record('articles', { fields: [currentField] })];
		const desired = [record('articles', { fields: [desiredField] })];
		const result = plan(current, desired);
		return result.update.find((entry) => entry.changeKind === 'fields');
	}

	it('marks an added attribute, a removed attribute, and a nested edit distinctly', () => {
		const added = fieldUpdate(
			fieldObject({ collection: 'articles', field: 'title', type: 'string', meta: { note: 'keep' } }),
			fieldObject({
				collection: 'articles',
				field: 'title',
				type: 'string',
				meta: { note: 'keep' },
				schema: { name: 'title' },
			})
		);

		expect(added!.changes['schema']).toMatchObject({ beforePresent: false });
		expect(added!.changes['schema']!.after).toEqual({ name: 'title' });

		const removed = fieldUpdate(
			fieldObject({ collection: 'articles', field: 'title', type: 'string', meta: null, schema: { name: 'title' } }),
			fieldObject({ collection: 'articles', field: 'title', type: 'string', schema: { name: 'title' } })
		);

		expect(removed!.changes['meta']).toMatchObject({ afterPresent: false });

		const nested = fieldUpdate(
			fieldObject({
				collection: 'articles',
				field: 'title',
				type: 'string',
				meta: { note: 'old' },
				schema: { name: 'title' },
			}),
			fieldObject({
				collection: 'articles',
				field: 'title',
				type: 'string',
				meta: { note: 'new' },
				schema: { name: 'title' },
			})
		);

		expect(nested!.changes['meta']).toEqual({ before: { note: 'old' }, after: { note: 'new' } });
	});

	it('keeps presence distinctions through a JSON round trip', () => {
		const removed = fieldUpdate(
			fieldObject({ collection: 'articles', field: 'title', type: 'string', meta: null, schema: { name: 'title' } }),
			fieldObject({ collection: 'articles', field: 'title', type: 'string', schema: { name: 'title' } })
		);

		const roundTripped = JSON.parse(JSON.stringify(removed!.changes['meta']));
		expect(roundTripped.afterPresent).toBe(false);

		const explicitNull = fieldUpdate(
			fieldObject({
				collection: 'articles',
				field: 'title',
				type: 'string',
				meta: { note: 'old' },
				schema: { name: 'title' },
			}),
			fieldObject({ collection: 'articles', field: 'title', type: 'string', meta: null, schema: { name: 'title' } })
		);

		const explicit = JSON.parse(JSON.stringify(explicitNull!.changes['meta']));
		expect(explicit.after).toBeNull();
		expect(explicit.afterPresent).toBeUndefined();
	});

	it('marks a collection-level meta removal and null edit distinctly', () => {
		const current: ConfigSchemaCollection = {
			collection: 'articles',
			meta: { note: 'keep' } as never,
			schema: { name: 'articles' } as Exclude<ConfigSchemaCollection['schema'], undefined>,
			fields: [],
			relations: [],
		};

		const removed = {
			collection: 'articles',
			schema: { name: 'articles' },
			fields: [],
			relations: [],
		} as unknown as ConfigSchemaCollection;

		const removalPlan = computeSchemaPlan([current], [removed], []);
		const removalUpdate = removalPlan.update.find((entry) => entry.changeKind === 'collections');
		expect(removalUpdate!.changes['meta']).toMatchObject({ afterPresent: false });

		const nulled: ConfigSchemaCollection = {
			collection: 'articles',
			meta: null,
			schema: { name: 'articles' } as Exclude<ConfigSchemaCollection['schema'], undefined>,
			fields: [],
			relations: [],
		};

		const nullPlan = computeSchemaPlan([current], [nulled], []);
		const nullUpdate = nullPlan.update.find((entry) => entry.changeKind === 'collections');
		expect(nullUpdate!.changes['meta']).toEqual({ before: { note: 'keep' }, after: null });
	});
});

describe('computeSchemaPlan omitted-property contract', () => {
	it('plans no change when a partial field omits a meta and a column property', () => {
		const current = [
			record('articles', {
				fields: [
					fieldObject({
						collection: 'articles',
						field: 'title',
						type: 'string',
						meta: { note: 'keep' },
						schema: { name: 'title', data_type: 'varchar', max_length: 1000 },
					}),
				],
			}),
		];

		const desired = [
			record('articles', {
				fields: [
					fieldObject({
						collection: 'articles',
						field: 'title',
						type: 'string',
						meta: {},
						schema: { name: 'title', data_type: 'varchar' },
					}),
				],
			}),
		];

		expect(plan(current, desired)).toEqual({ create: [], update: [], delete: [] });
	});

	it('plans only the explicit change when a property is restated and another omitted', () => {
		const current = [
			record('articles', {
				fields: [
					fieldObject({
						collection: 'articles',
						field: 'title',
						type: 'string',
						meta: { note: 'old' },
						schema: { name: 'title', data_type: 'varchar', max_length: 1000 },
					}),
				],
			}),
		];

		const desired = [
			record('articles', {
				fields: [
					fieldObject({
						collection: 'articles',
						field: 'title',
						type: 'string',
						meta: { note: 'new' },
						schema: { name: 'title', data_type: 'varchar' },
					}),
				],
			}),
		];

		const update = plan(current, desired).update.find((entry) => entry.changeKind === 'fields');

		expect(Object.keys(update!.changes)).toEqual(['meta']);
		expect(update!.changes['meta']).toEqual({ before: { note: 'old' }, after: { note: 'new' } });
	});

	it('refuses a boundary-crossing interface change that omits options on the config path', () => {
		const current = [
			record('media', {
				fields: [
					fieldObject({
						collection: 'media',
						field: 'cover',
						type: 'uuid',
						meta: { interface: 'file', options: { folder: 'images' } },
						schema: { name: 'cover' },
					}),
				],
			}),
		];

		const desired = [
			record('media', {
				fields: [
					fieldObject({
						collection: 'media',
						field: 'cover',
						type: 'uuid',
						meta: { interface: 'custom-widget' },
						schema: { name: 'cover' },
					}),
				],
			}),
		];

		expect(() => plan(current, desired)).toThrow(ConfigInvalidException);
		expect(() => plan(current, desired)).toThrow(/Restate "meta.options"/);
	});

	it('refuses entering the registry while omitting options on the config path', () => {
		const current = [
			record('media', {
				fields: [
					fieldObject({
						collection: 'media',
						field: 'cover',
						type: 'uuid',
						meta: { interface: 'custom-widget', options: { folder: 'folder-key' } },
						schema: { name: 'cover' },
					}),
				],
			}),
		];

		const desired = [
			record('media', {
				fields: [
					fieldObject({
						collection: 'media',
						field: 'cover',
						type: 'uuid',
						meta: { interface: 'file' },
						schema: { name: 'cover' },
					}),
				],
			}),
		];

		expect(() => plan(current, desired)).toThrow(ConfigInvalidException);
		expect(() => plan(current, desired)).toThrow(/Restate "meta.options"/);
	});

	it('plans no change when a field omits its interface but keeps its folder reference', () => {
		const current = fieldObject({
			collection: 'media',
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'file', options: { folder: 'folder-key' } },
			schema: { name: 'cover' },
		});

		const stored = fieldObject({
			collection: 'media',
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'file', options: { folder: 'folder-id' } },
			schema: { name: 'cover' },
		});

		const desired = fieldObject({
			collection: 'media',
			field: 'cover',
			type: 'uuid',
			meta: { options: { folder: 'folder-key' } },
			schema: { name: 'cover' },
		});

		const result = computeSchemaPlan(
			[record('media', { fields: [current] })],
			[record('media', { fields: [desired] })],
			[stored]
		);

		expect(result.update.find((entry) => entry.changeKind === 'fields')).toBeUndefined();
	});
});

describe('schema validateDesired', () => {
	function validate(documents: ConfigSchemaCollection[]) {
		return schemaDescriptor.handler.validateDesired(documents as never, documents as never, {} as never);
	}

	it('admits a well-formed tree, a metadata-only group, a table without a collection record, and system fields', () => {
		const group: ConfigSchemaCollection = {
			collection: 'people',
			meta: collectionMeta('people'),
			fields: [],
			relations: [],
		};

		const documents = [
			record('articles', { fields: [makeField('articles', 'title')] }),
			group,
			record('labels', { meta: null, fields: [makeField('labels', 'code')] }),
			systemRecord('directus_users', [makeField('directus_users', 'nickname')]),
		];

		expect(validate(documents)).toEqual([]);
	});

	it.each([
		['only fields and relations', { collection: 'articles', fields: [makeField('articles', 'title')], relations: [] }],
		['a schema without meta', { collection: 'articles', schema: { name: 'articles' }, fields: [], relations: [] }],
	])('rejects a collection that declares %s', (_label, document) => {
		const failures = validate([document as unknown as ConfigSchemaCollection]);

		expect(failures).toEqual([
			expect.objectContaining({
				code: 'CONFIG_INVALID',
				message: 'Schema collection "articles" must declare "meta", which can be null.',
			}),
		]);
	});

	it('rejects a duplicate collection identity', () => {
		const failures = validate([record('articles'), record('articles')]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_IDENTITY_CONFLICT' }));
	});

	it('rejects a field without a field name', () => {
		const broken = record('articles', { fields: [{ collection: 'articles' } as unknown as SnapshotField] });
		const failures = validate([broken]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_INVALID' }));
	});

	it('rejects a field with an unsupported type', () => {
		const broken = record('articles', { fields: [makeField('articles', 'title', { type: 'not-a-type' })] });
		const failures = validate([broken]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_INVALID' }));
	});

	it('rejects a field whose schema is not an object', () => {
		const broken = record('articles', { fields: [makeField('articles', 'title', { schema: 'not-a-schema' })] });
		const failures = validate([broken]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_INVALID' }));
	});

	it('rejects a non-boolean is_nullable without coercion', () => {
		const broken = record('articles', {
			fields: [makeField('articles', 'title', { schema: { name: 'title', is_nullable: 'true' } })],
		});

		const failures = validate([broken]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_INVALID' }));
	});

	it('rejects a nested field whose collection does not match its owner', () => {
		const broken = record('articles', { fields: [makeField('other', 'title')] });
		const failures = validate([broken]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_INVALID' }));
	});

	it('rejects a system collection carrying a definition', () => {
		const broken = record('directus_users', { fields: [makeField('directus_users', 'nickname')] });
		const failures = validate([broken]);
		expect(failures).toContainEqual(expect.objectContaining({ code: 'CONFIG_INVALID' }));
	});

	it.each([
		['meta', { meta: null }],
		['schema', { schema: { name: 'directus_users' } }],
	])('rejects a system collection declaring only %s', (_label, definition) => {
		const broken = { ...systemRecord('directus_users', [makeField('directus_users', 'nickname')]), ...definition };

		expect(validate([broken as ConfigSchemaCollection])).toEqual([
			expect.objectContaining({
				code: 'CONFIG_INVALID',
				message: 'System collection "directus_users" must declare only fields, not a collection definition.',
			}),
		]);
	});

	it('accepts field types beyond the knex column set', () => {
		for (const type of ['hash', 'csv', 'geometry', 'unknown']) {
			const documents = [record('articles', { fields: [makeField('articles', 'value', { type })] })];
			expect(validate(documents)).toEqual([]);
		}
	});

	it('sanitizes control characters in a Joi diagnostic', () => {
		const bel = String.fromCharCode(7);

		const broken = record('articles', {
			fields: [fieldObject({ collection: 'articles', field: 'title', type: 'string', [`evil${bel}key`]: 'x' })],
		});

		const failures = validate([broken]);

		expect(failures.length).toBeGreaterThan(0);
		expect(failures.every((failure) => !failure.message.includes(bel))).toBe(true);
		expect(failures.some((failure) => failure.message.includes('evil?key'))).toBe(true);
	});
});
