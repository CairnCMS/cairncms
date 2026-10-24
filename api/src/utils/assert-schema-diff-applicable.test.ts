import type { FieldOverview, SchemaOverview } from '@cairncms/types';
import { cloneDeep } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotDiff } from '../types/index.js';
import { assertSchemaDiffApplicable } from './assert-schema-diff-applicable.js';
import { getSnapshotDiff } from './get-snapshot-diff.js';

function fieldOverview(field: string, type = 'string'): FieldOverview {
	return {
		field,
		type: type as FieldOverview['type'],
		defaultValue: null,
		nullable: true,
		generated: false,
		dbType: null,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: type === 'alias',
	};
}

function collectionOverview(collection: string, primary: string, fields: Record<string, string>) {
	return {
		collection,
		primary,
		singleton: false,
		sortField: null,
		note: null,
		accountability: 'all' as const,
		fields: Object.fromEntries(Object.entries(fields).map(([field, type]) => [field, fieldOverview(field, type)])),
	};
}

const newDiff = (rhs: unknown) => [{ kind: 'N', rhs }] as any;
const deleteDiff = (lhs: unknown) => [{ kind: 'D', lhs }] as any;
const editDiff = (path: (string | number)[], lhs: unknown, rhs: unknown) => [{ kind: 'E', path, lhs, rhs }] as any;

const collection = (name: string, schema: unknown = {}, group: string | null = null) => ({
	collection: name,
	meta: { group },
	schema,
});

const field = (
	coll: string,
	name: string,
	type = 'string',
	schema: Record<string, unknown> | null = {},
	special: string[] = []
) => ({
	collection: coll,
	field: name,
	type,
	schema,
	meta: { special },
});

const aliasField = (coll: string, name: string) => field(coll, name, 'alias', null, ['o2m']);

const relation = (coll: string, name: string, related: string | null, oneField: string | null = null) => ({
	collection: coll,
	field: name,
	related_collection: related,
	schema: null,
	meta: { one_field: oneField },
});

const emptyDiff = (): SnapshotDiff => ({ collections: [], fields: [], relations: [] });

const snapshot = (parts: Partial<Snapshot>): Snapshot =>
	({ version: 1, directus: '0', collections: [], fields: [], relations: [], ...parts } as unknown as Snapshot);

const schemaOverview = (
	collections: ReturnType<typeof collectionOverview>[],
	relations: unknown[] = []
): SchemaOverview =>
	({
		collections: Object.fromEntries(collections.map((entry) => [entry.collection, entry])),
		relations,
	} as unknown as SchemaOverview);

describe('assertSchemaDiffApplicable', () => {
	it('accepts a plan that creates a collection, a field, and a relation together', () => {
		const diff = emptyDiff();

		diff.collections = [
			{ collection: 'authors', diff: newDiff(collection('authors')) },
			{ collection: 'articles', diff: newDiff(collection('articles')) },
		];

		diff.fields = [
			{
				collection: 'authors',
				field: 'id',
				diff: newDiff(field('authors', 'id', 'integer', { is_primary_key: true })),
			},
			{
				collection: 'articles',
				field: 'id',
				diff: newDiff(field('articles', 'id', 'integer', { is_primary_key: true })),
			},
			{ collection: 'articles', field: 'author', diff: newDiff(field('articles', 'author', 'integer')) },
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'author',
				related_collection: 'authors',
				diff: newDiff(relation('articles', 'author', 'authors')),
			},
		];

		expect(() => assertSchemaDiffApplicable(diff, snapshot({}), schemaOverview([]))).not.toThrow();
	});

	it('accepts a new field on an existing collection used by a new relation', () => {
		const diff = emptyDiff();

		diff.fields = [{ collection: 'articles', field: 'author', diff: newDiff(field('articles', 'author', 'integer')) }];

		diff.relations = [
			{
				collection: 'articles',
				field: 'author',
				related_collection: 'authors',
				diff: newDiff(relation('articles', 'author', 'authors')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer' }),
			collectionOverview('authors', 'id', { id: 'integer' }),
		]);

		const current = snapshot({
			collections: [collection('articles'), collection('authors')] as any,
			fields: [field('articles', 'id', 'integer'), field('authors', 'id', 'integer')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
	});

	it('refuses a field whose type is not supported, before any write', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'articles', field: 'bad', diff: newDiff(field('articles', 'bad', 'wibble')) }];

		const schema = schemaOverview([collectionOverview('articles', 'id', { id: 'integer' })]);

		const current = snapshot({
			collections: [collection('articles')] as any,
			fields: [field('articles', 'id', 'integer')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow('Illegal type passed: "wibble"');
	});

	it('refuses a field that already exists on the target collection', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'articles', field: 'title', diff: newDiff(field('articles', 'title', 'string')) }];

		const schema = schemaOverview([collectionOverview('articles', 'id', { id: 'integer', title: 'string' })]);

		const current = snapshot({
			collections: [collection('articles')] as any,
			fields: [field('articles', 'id', 'integer'), field('articles', 'title', 'string')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(
			'Field "title" already exists in collection "articles"'
		);
	});

	it('refuses changing a field to an alias type, before any write', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'articles', field: 'title', diff: editDiff(['type'], 'string', 'alias') }];

		const schema = schemaOverview([collectionOverview('articles', 'id', { id: 'integer', title: 'string' })]);

		const current = snapshot({
			collections: [collection('articles')] as any,
			fields: [field('articles', 'id', 'integer'), field('articles', 'title', 'string')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow('Alias type cannot be changed');
	});

	it('accepts a non-alias field update', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'articles', field: 'title', diff: editDiff(['meta', 'note'], null, 'a note') }];

		const schema = schemaOverview([collectionOverview('articles', 'id', { id: 'integer', title: 'string' })]);

		const current = snapshot({
			collections: [collection('articles')] as any,
			fields: [field('articles', 'id', 'integer'), field('articles', 'title', 'string')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
	});

	it('refuses creating a collection whose name a metadata-only group already reserves', () => {
		const diff = emptyDiff();
		diff.collections = [{ collection: 'dashboards', diff: newDiff(collection('dashboards')) }];

		diff.fields = [
			{
				collection: 'dashboards',
				field: 'id',
				diff: newDiff(field('dashboards', 'id', 'integer', { is_primary_key: true })),
			},
		];

		const current = snapshot({ collections: [collection('dashboards', null)] as any });

		expect(() => assertSchemaDiffApplicable(diff, current, schemaOverview([]))).toThrow(
			'Collection "dashboards" already exists.'
		);
	});

	it('refuses a relation whose related collection is a metadata-only group', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'articles', field: 'board', diff: newDiff(field('articles', 'board', 'integer')) }];

		diff.relations = [
			{
				collection: 'articles',
				field: 'board',
				related_collection: 'dashboards',
				diff: newDiff(relation('articles', 'board', 'dashboards')),
			},
		];

		const schema = schemaOverview([collectionOverview('articles', 'id', { id: 'integer' })]);

		const current = snapshot({
			collections: [collection('articles'), collection('dashboards', null)] as any,
			fields: [field('articles', 'id', 'integer')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(`Collection "dashboards" doesn't exist`);
	});

	it('refuses converting a cascaded-away alias field to a concrete type', () => {
		const diff = emptyDiff();

		diff.fields = [
			{ collection: 'articles', field: 'author', diff: deleteDiff(field('articles', 'author', 'integer')) },
			{ collection: 'authors', field: 'articles', diff: editDiff(['type'], 'alias', 'string') },
		];

		const schema = schemaOverview(
			[
				collectionOverview('articles', 'id', { id: 'integer', author: 'integer' }),
				collectionOverview('authors', 'id', { id: 'integer', articles: 'alias' }),
			],
			[relation('articles', 'author', 'authors', 'articles')]
		);

		const current = snapshot({
			collections: [collection('articles'), collection('authors')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				field('articles', 'author', 'integer'),
				field('authors', 'id', 'integer'),
				aliasField('authors', 'articles'),
			] as any,
			relations: [relation('articles', 'author', 'authors', 'articles')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow('Alias type cannot be changed');
	});

	it('refuses a relation on a field an update removed from the runtime schema', () => {
		const diff = emptyDiff();

		diff.fields = [
			{ collection: 'articles', field: 'widget', diff: editDiff(['meta', 'special'], ['o2m'], ['no-data']) },
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'widget',
				related_collection: 'targets',
				diff: newDiff(relation('articles', 'widget', 'targets')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer', widget: 'alias' }),
			collectionOverview('targets', 'id', { id: 'integer' }),
		]);

		const current = snapshot({
			collections: [collection('articles'), collection('targets')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				aliasField('articles', 'widget'),
				field('targets', 'id', 'integer'),
			] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(
			`Field "widget" doesn't exist in collection "articles"`
		);
	});

	it('keeps a no-data field that still backs a column in the runtime schema', () => {
		const diff = emptyDiff();

		diff.fields = [{ collection: 'articles', field: 'tag', diff: editDiff(['meta', 'special'], [], ['no-data']) }];

		diff.relations = [
			{
				collection: 'articles',
				field: 'tag',
				related_collection: 'targets',
				diff: newDiff(relation('articles', 'tag', 'targets')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer', tag: 'string' }),
			collectionOverview('targets', 'id', { id: 'integer' }),
		]);

		const current = snapshot({
			collections: [collection('articles'), collection('targets')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				field('articles', 'tag', 'string'),
				field('targets', 'id', 'integer'),
			] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
	});

	it('refuses a relation on a field an earlier change promotes to the primary key', () => {
		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'articles',
				field: 'id',
				diff: deleteDiff(field('articles', 'id', 'integer', { is_primary_key: true })),
			},
			{
				collection: 'articles',
				field: 'new_key',
				diff: newDiff(field('articles', 'new_key', 'integer', { is_primary_key: true })),
			},
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'new_key',
				related_collection: 'targets',
				diff: newDiff(relation('articles', 'new_key', 'targets')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer' }),
			collectionOverview('targets', 'id', { id: 'integer' }),
		]);

		const current = snapshot({
			collections: [collection('articles'), collection('targets')] as any,
			fields: [field('articles', 'id', 'integer', { is_primary_key: true }), field('targets', 'id', 'integer')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(
			`Field "new_key" in collection "articles" is a primary key`
		);
	});

	it('refuses a relation to a collection that lost its only primary key', () => {
		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'targets',
				field: 'id',
				diff: deleteDiff(field('targets', 'id', 'integer', { is_primary_key: true })),
			},
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'ref',
				related_collection: 'targets',
				diff: newDiff(relation('articles', 'ref', 'targets')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer', ref: 'integer' }),
			collectionOverview('targets', 'id', { id: 'integer', name: 'string' }),
		]);

		const current = snapshot({
			collections: [collection('articles'), collection('targets')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				field('articles', 'ref', 'integer'),
				field('targets', 'id', 'integer', { is_primary_key: true }),
				field('targets', 'name', 'string'),
			] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(`Collection "targets" doesn't exist`);
	});

	it('accepts a relation when a replacement primary key keeps the collection eligible', () => {
		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'targets',
				field: 'id',
				diff: deleteDiff(field('targets', 'id', 'integer', { is_primary_key: true })),
			},
			{
				collection: 'targets',
				field: 'new_id',
				diff: newDiff(field('targets', 'new_id', 'integer', { is_primary_key: true })),
			},
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'ref',
				related_collection: 'targets',
				diff: newDiff(relation('articles', 'ref', 'targets')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer', ref: 'integer' }),
			collectionOverview('targets', 'id', { id: 'integer', name: 'string' }),
		]);

		const current = snapshot({
			collections: [collection('articles'), collection('targets')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				field('articles', 'ref', 'integer'),
				field('targets', 'id', 'integer', { is_primary_key: true }),
				field('targets', 'name', 'string'),
			] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
	});

	it('accepts deleting only an o2m alias field, keeping the relationship', () => {
		const diff = emptyDiff();

		diff.fields = [{ collection: 'authors', field: 'articles', diff: deleteDiff(aliasField('authors', 'articles')) }];

		diff.relations = [
			{
				collection: 'articles',
				field: 'author',
				related_collection: 'authors',
				diff: editDiff(['meta', 'one_field'], 'articles', null),
			},
		];

		const schema = schemaOverview(
			[
				collectionOverview('articles', 'id', { id: 'integer', author: 'integer' }),
				collectionOverview('authors', 'id', { id: 'integer', articles: 'alias' }),
			],
			[relation('articles', 'author', 'authors', 'articles')]
		);

		const current = snapshot({
			collections: [collection('articles'), collection('authors')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				field('articles', 'author', 'integer'),
				field('authors', 'id', 'integer'),
				aliasField('authors', 'articles'),
			] as any,
			relations: [relation('articles', 'author', 'authors', 'articles')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
	});

	it('accepts deleting two interrelated collections together', () => {
		const diff = emptyDiff();

		diff.collections = [
			{ collection: 'articles', diff: deleteDiff(collection('articles')) },
			{ collection: 'authors', diff: deleteDiff(collection('authors')) },
		];

		diff.fields = [
			{ collection: 'articles', field: 'id', diff: deleteDiff(field('articles', 'id', 'integer')) },
			{ collection: 'articles', field: 'author', diff: deleteDiff(field('articles', 'author', 'integer')) },
			{ collection: 'authors', field: 'id', diff: deleteDiff(field('authors', 'id', 'integer')) },
			{ collection: 'authors', field: 'articles', diff: deleteDiff(aliasField('authors', 'articles')) },
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'author',
				related_collection: 'authors',
				diff: deleteDiff(relation('articles', 'author', 'authors', 'articles')),
			},
		];

		const schema = schemaOverview(
			[
				collectionOverview('articles', 'id', { id: 'integer', author: 'integer' }),
				collectionOverview('authors', 'id', { id: 'integer', articles: 'alias' }),
			],
			[relation('articles', 'author', 'authors', 'articles')]
		);

		const current = snapshot({
			collections: [collection('articles'), collection('authors')] as any,
			fields: [
				field('articles', 'id', 'integer'),
				field('articles', 'author', 'integer'),
				field('authors', 'id', 'integer'),
				aliasField('authors', 'articles'),
			] as any,
			relations: [relation('articles', 'author', 'authors', 'articles')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
	});

	it('refuses deleting a collection that no longer exists', () => {
		const diff = emptyDiff();
		diff.collections = [{ collection: 'ghost', diff: deleteDiff(collection('ghost')) }];

		expect(() => assertSchemaDiffApplicable(diff, snapshot({}), schemaOverview([]))).toThrow();
	});

	describe('a new collection grouped under another', () => {
		const groupedUnder = (group: string, ...others: SnapshotDiff['collections']): SnapshotDiff => {
			const diff = emptyDiff();
			diff.collections = [{ collection: 'articles', diff: newDiff(collection('articles', {}, group)) }, ...others];

			diff.fields = [
				{
					collection: 'articles',
					field: 'id',
					diff: newDiff(field('articles', 'id', 'integer', { is_primary_key: true })),
				},
			];

			return diff;
		};

		const missingMetadata = `Collection "articles" can't be grouped under "content", which has no collection metadata.`;

		it('refuses a group that does not exist', () => {
			expect(() => assertSchemaDiffApplicable(groupedUnder('content'), snapshot({}), schemaOverview([]))).toThrow(
				missingMetadata
			);
		});

		it('refuses a group that is a current table without metadata', () => {
			const current = snapshot({ collections: [{ collection: 'content', meta: null, schema: {} }] as any });

			expect(() => assertSchemaDiffApplicable(groupedUnder('content'), current, schemaOverview([]))).toThrow(
				missingMetadata
			);
		});

		it('refuses a group the diff creates without metadata', () => {
			const diff = groupedUnder('content', {
				collection: 'content',
				diff: newDiff({ collection: 'content', meta: null, schema: null }),
			});

			expect(() => assertSchemaDiffApplicable(diff, snapshot({}), schemaOverview([]))).toThrow(missingMetadata);
		});

		it('accepts a group that is a current collection with metadata', () => {
			const current = snapshot({ collections: [collection('content', null)] as any });

			expect(() => assertSchemaDiffApplicable(groupedUnder('content'), current, schemaOverview([]))).not.toThrow();
		});

		it('accepts a group the diff creates with metadata', () => {
			const diff = groupedUnder('content', { collection: 'content', diff: newDiff(collection('content', null)) });

			expect(() => assertSchemaDiffApplicable(diff, snapshot({}), schemaOverview([]))).not.toThrow();
		});

		it('refuses new collections whose groups form a cycle', () => {
			const diff = emptyDiff();

			diff.collections = [
				{ collection: 'a', diff: newDiff(collection('a', null, 'b')) },
				{ collection: 'b', diff: newDiff(collection('b', null, 'a')) },
			];

			expect(() => assertSchemaDiffApplicable(diff, snapshot({}), schemaOverview([]))).toThrow(
				/can't be grouped under itself through a group cycle/
			);
		});
	});

	it('refuses a diff that removes the table of a kept collection', () => {
		const diff = emptyDiff();

		diff.collections = [
			{ collection: 'articles', diff: [{ kind: 'D', path: ['schema'], lhs: { name: 'articles' } }] as any },
		];

		const current = snapshot({ collections: [collection('articles')] as any });

		expect(() =>
			assertSchemaDiffApplicable(
				diff,
				current,
				schemaOverview([collectionOverview('articles', 'id', { id: 'integer' })])
			)
		).toThrow(`Collection "articles" can't remove its table and remain as a collection.`);
	});

	it('refuses deleting a grouped collection that no longer exists', () => {
		const diff = emptyDiff();
		diff.collections = [{ collection: 'ghost', diff: deleteDiff(collection('ghost', {}, 'content')) }];

		const current = snapshot({ collections: [collection('content', null)] as any });

		expect(() => assertSchemaDiffApplicable(diff, current, schemaOverview([]))).toThrow();
	});

	it.each([
		['whose group survives', collection('notes', {}, 'content')],
		['that has no metadata row', { collection: 'notes', meta: null, schema: {} }],
	])('refuses a relation to a dropped collection %s', (_case, dropped) => {
		const diff = emptyDiff();
		diff.collections = [{ collection: 'notes', diff: deleteDiff(dropped) }];
		diff.fields = [{ collection: 'articles', field: 'note', diff: newDiff(field('articles', 'note', 'integer')) }];

		diff.relations = [
			{
				collection: 'articles',
				field: 'note',
				related_collection: 'notes',
				diff: newDiff(relation('articles', 'note', 'notes')),
			},
		];

		const schema = schemaOverview([
			collectionOverview('articles', 'id', { id: 'integer' }),
			collectionOverview('notes', 'id', { id: 'integer' }),
		]);

		const current = snapshot({
			collections: [collection('content', null), collection('articles'), dropped] as any,
			fields: [field('articles', 'id', 'integer'), field('notes', 'id', 'integer')] as any,
		});

		expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(`Collection "notes" doesn't exist`);
	});

	describe('a primary key follows the column the builder writes', () => {
		const autoIncrementOnly = { is_primary_key: false, has_auto_increment: true };
		const flagged = { is_primary_key: true };
		const refused = `Collection "targets" doesn't exist`;

		const referencingTargets = (diff: SnapshotDiff): SnapshotDiff => {
			diff.relations = [
				{
					collection: 'articles',
					field: 'ref',
					related_collection: 'targets',
					diff: newDiff(relation('articles', 'ref', 'targets')),
				},
			];

			return diff;
		};

		const articlesOnly = () => ({
			schema: schemaOverview([collectionOverview('articles', 'id', { id: 'integer', ref: 'integer' })]),
			current: snapshot({
				collections: [collection('articles')] as any,
				fields: [field('articles', 'id', 'integer'), field('articles', 'ref', 'integer')] as any,
			}),
		});

		const existingTargets = (extra: Record<string, unknown>[] = []) => ({
			schema: schemaOverview([
				collectionOverview('articles', 'id', { id: 'integer', ref: 'integer' }),
				collectionOverview('targets', 'id', { id: 'integer', code: 'integer', blob: 'unknown' }),
			]),
			current: snapshot({
				collections: [collection('articles'), collection('targets')] as any,
				fields: [
					field('articles', 'id', 'integer'),
					field('articles', 'ref', 'integer'),
					field('targets', 'id', 'integer', flagged),
					...extra,
				] as any,
			}),
		});

		const droppingTargetsKey = (...changes: SnapshotDiff['fields']): SnapshotDiff => {
			const diff = emptyDiff();

			diff.fields = [
				{ collection: 'targets', field: 'id', diff: deleteDiff(field('targets', 'id', 'integer', flagged)) },
				...changes,
			];

			return referencingTargets(diff);
		};

		describe('in a new collection', () => {
			const newTargets = (type: string, key: Record<string, unknown>): SnapshotDiff => {
				const diff = emptyDiff();
				diff.collections = [{ collection: 'targets', diff: newDiff(collection('targets')) }];

				diff.fields = [
					{ collection: 'targets', field: 'id', diff: newDiff(field('targets', 'id', type, key)) },
					{ collection: 'targets', field: 'name', diff: newDiff(field('targets', 'name', 'string')) },
				];

				return referencingTargets(diff);
			};

			it('accepts a relation to a collection keyed only by an auto-increment field', () => {
				const { schema, current } = articlesOnly();

				expect(() =>
					assertSchemaDiffApplicable(newTargets('integer', autoIncrementOnly), current, schema)
				).not.toThrow();
			});

			it.each(['unknown', 'o2m'])('refuses a relation to a collection keyed by a flagged %s field', (type) => {
				const { schema, current } = articlesOnly();

				expect(() => assertSchemaDiffApplicable(newTargets(type, flagged), current, schema)).toThrow(refused);
			});
		});

		describe('in a field created on an existing collection', () => {
			const createdKey = (type: string, key: Record<string, unknown>) => ({
				collection: 'targets',
				field: 'new_id',
				diff: newDiff(field('targets', 'new_id', type, key)),
			});

			it('accepts a relation when an auto-increment field replaces the dropped key', () => {
				const { schema, current } = existingTargets();
				const diff = droppingTargetsKey(createdKey('integer', autoIncrementOnly));

				expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
			});

			it('refuses a relation when a flagged unknown-typed field replaces the dropped key', () => {
				const { schema, current } = existingTargets();
				const diff = droppingTargetsKey(createdKey('unknown', flagged));

				expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(refused);
			});
		});

		describe('in a field updated on an existing collection', () => {
			it('accepts a relation when an updated field starts to auto-increment', () => {
				const { schema, current } = existingTargets([
					field('targets', 'code', 'integer', { is_primary_key: false, has_auto_increment: false }),
				]);

				const diff = droppingTargetsKey({
					collection: 'targets',
					field: 'code',
					diff: editDiff(['schema', 'has_auto_increment'], false, true),
				});

				expect(() => assertSchemaDiffApplicable(diff, current, schema)).not.toThrow();
			});

			it('refuses a relation when an updated unknown-typed field is flagged as the key', () => {
				const { schema, current } = existingTargets([field('targets', 'blob', 'unknown', { is_primary_key: false })]);

				const diff = droppingTargetsKey({
					collection: 'targets',
					field: 'blob',
					diff: editDiff(['schema', 'is_primary_key'], false, true),
				});

				expect(() => assertSchemaDiffApplicable(diff, current, schema)).toThrow(refused);
			});
		});
	});
});

describe('assertSchemaDiffApplicable on attribute changes to kept fields and relations', () => {
	const relationMeta = (field: string, related: string | null, extra: Record<string, unknown> = {}) => ({
		many_collection: 'articles',
		many_field: field,
		one_collection: related,
		one_field: null,
		one_collection_field: null,
		one_allowed_collections: null,
		one_deselect_action: 'nullify',
		junction_field: null,
		sort_field: null,
		...extra,
	});

	const foreignKey = (field: string, related: string) => ({
		table: 'articles',
		column: field,
		foreign_key_table: related,
		foreign_key_column: 'id',
		constraint_name: `articles_${field}_foreign`,
		on_update: 'NO ACTION',
		on_delete: 'SET NULL',
	});

	const relations = () => [
		{
			collection: 'articles',
			field: 'author',
			related_collection: 'authors',
			meta: relationMeta('author', 'authors'),
			schema: foreignKey('author', 'authors'),
		},
		{
			collection: 'articles',
			field: 'editor',
			related_collection: 'editors',
			meta: null,
			schema: foreignKey('editor', 'editors'),
		},
		{
			collection: 'articles',
			field: 'item',
			related_collection: null,
			meta: relationMeta('item', null, { one_allowed_collections: ['authors', 'editors'] }),
			schema: null,
		},
	];

	const current = (): Snapshot =>
		snapshot({
			collections: ['articles', 'authors', 'editors'].map((name) => collection(name, { name })),
			fields: [
				{
					collection: 'articles',
					field: 'id',
					type: 'integer',
					meta: null,
					schema: { name: 'id', table: 'articles', is_primary_key: true, has_auto_increment: true },
				},
				{
					collection: 'articles',
					field: 'title',
					type: 'string',
					meta: { collection: 'articles', field: 'title', note: 'Headline' },
					schema: {
						name: 'title',
						table: 'articles',
						data_type: 'varchar',
						default_value: 'Untitled',
						max_length: 1000,
						is_nullable: false,
					},
				},
				{
					collection: 'articles',
					field: 'legacy',
					type: 'integer',
					meta: null,
					schema: { name: 'legacy', table: 'articles', data_type: 'integer' },
				},
				aliasField('articles', 'comments'),
			],
			relations: relations(),
		} as unknown as Partial<Snapshot>);

	const overview = () =>
		schemaOverview(
			[
				collectionOverview('articles', 'id', {
					id: 'integer',
					title: 'string',
					legacy: 'integer',
					author: 'integer',
					editor: 'integer',
					item: 'string',
				}),
				collectionOverview('authors', 'id', { id: 'integer', favorite: 'integer' }),
				collectionOverview('editors', 'id', { id: 'integer' }),
			],
			relations()
		);

	const fieldOf = (target: Snapshot, name: string) => target.fields.find((entry) => entry.field === name)! as any;
	const relationOf = (target: Snapshot, name: string) => target.relations.find((entry) => entry.field === name)! as any;

	function applying(edit: (desired: Snapshot) => void): () => void {
		const before = current();
		const desired = cloneDeep(before);
		edit(desired);

		return () => assertSchemaDiffApplicable(getSnapshotDiff(before, desired), before, overview());
	}

	it.each([
		[
			'an omitted schema',
			(d: Snapshot) => delete fieldOf(d, 'title').schema,
			`can't remove its column and remain as a field.`,
		],
		[
			'a null schema',
			(d: Snapshot) => (fieldOf(d, 'title').schema = null),
			`can't remove its column and remain as a field.`,
		],
		['an omitted meta', (d: Snapshot) => delete fieldOf(d, 'title').meta, `can't remove its field metadata.`],
		['an omitted type', (d: Snapshot) => delete fieldOf(d, 'title').type, `can't remove its type.`],
		[
			'an omitted schema.max_length',
			(d: Snapshot) => delete fieldOf(d, 'title').schema.max_length,
			`can't omit "schema.max_length" from its column definition.`,
		],
		[
			'an omitted schema.default_value',
			(d: Snapshot) => delete fieldOf(d, 'title').schema.default_value,
			`can't omit "schema.default_value" from its column definition.`,
		],
		[
			'an omitted schema.is_nullable',
			(d: Snapshot) => delete fieldOf(d, 'title').schema.is_nullable,
			`can't omit "schema.is_nullable" from its column definition.`,
		],
	])('refuses a kept field with %s', (_case, edit, message) => {
		expect(applying(edit)).toThrow(`Field "articles.title" ${message}`);
	});

	it('refuses a column added to a kept field', () => {
		expect(applying((d) => (fieldOf(d, 'comments').schema = { name: 'comments', table: 'articles' }))).toThrow(
			`Field "articles.comments" can't add a column to an existing field.`
		);
	});

	it.each([
		[
			'an omitted schema',
			(d: Snapshot) => delete relationOf(d, 'author').schema,
			`can't remove its foreign key and remain as a relation.`,
		],
		['an omitted meta', (d: Snapshot) => delete relationOf(d, 'author').meta, `can't remove its relation metadata.`],
		[
			'related_collection alone changed',
			(d: Snapshot) => (relationOf(d, 'author').related_collection = 'editors'),
			`can't change its related collection.`,
		],
		[
			'meta.one_collection alone changed',
			(d: Snapshot) => (relationOf(d, 'author').meta.one_collection = 'editors'),
			`can't change its related collection.`,
		],
		[
			'schema.foreign_key_table alone changed',
			(d: Snapshot) => (relationOf(d, 'author').schema.foreign_key_table = 'editors'),
			`can't change its related collection.`,
		],
		[
			'schema.foreign_key_column alone changed',
			(d: Snapshot) => (relationOf(d, 'author').schema.foreign_key_column = 'uuid'),
			`can't change its related collection.`,
		],
		[
			'meta.many_field alone changed',
			(d: Snapshot) => (relationOf(d, 'author').meta.many_field = 'editor'),
			`can't change the field it belongs to.`,
		],
	])('refuses a kept relation with %s', (_case, edit, message) => {
		expect(applying(edit)).toThrow(`Relation "articles.author" ${message}`);
	});

	it('refuses a related collection set on a relation that had none', () => {
		expect(applying((d) => (relationOf(d, 'item').related_collection = 'authors'))).toThrow(
			`Relation "articles.item" can't change its related collection.`
		);
	});

	it('accepts gained relation metadata that names the current connection, and refuses one that names another', () => {
		expect(applying((d) => (relationOf(d, 'editor').meta = relationMeta('editor', 'editors')))).not.toThrow();

		expect(applying((d) => (relationOf(d, 'editor').meta = relationMeta('editor', 'authors')))).toThrow(
			`Relation "articles.editor" can't change its related collection.`
		);
	});

	it.each([
		['a changed meta.sort_field', (d: Snapshot) => (relationOf(d, 'author').meta.sort_field = 'position')],
		['a changed schema.on_delete', (d: Snapshot) => (relationOf(d, 'author').schema.on_delete = 'CASCADE')],
		['an omitted meta.sort_field', (d: Snapshot) => delete relationOf(d, 'author').meta.sort_field],
		['an omitted schema.on_delete', (d: Snapshot) => delete relationOf(d, 'author').schema.on_delete],
		['an omitted relation meta that is null', (d: Snapshot) => delete relationOf(d, 'editor').meta],
		['an omitted field meta.note', (d: Snapshot) => delete fieldOf(d, 'title').meta.note],
		['an omitted field meta that is null', (d: Snapshot) => delete fieldOf(d, 'legacy').meta],
	])('accepts %s', (_case, edit) => {
		expect(applying(edit)).not.toThrow();
	});

	it('keeps a field whose null meta is omitted, so its collection still takes a new relation', () => {
		const newRelation = {
			collection: 'authors',
			field: 'favorite',
			related_collection: 'articles',
			meta: relationMeta('favorite', 'articles', { many_collection: 'authors' }),
			schema: null,
		};

		const accepted = applying((d) => {
			delete fieldOf(d, 'id').meta;
			d.relations.push(newRelation as any);
		});

		expect(accepted).not.toThrow();
	});
});

describe('assertSchemaDiffApplicable keeps names that contain dots apart', () => {
	const current = (extraFields: unknown[] = []) =>
		snapshot({
			collections: [collection('a'), collection('a.b')] as any,
			fields: [
				field('a', 'id', 'integer'),
				field('a', 'b.c', 'integer'),
				field('a.b', 'id', 'integer'),
				...extraFields,
			] as any,
		});

	const overview = () =>
		schemaOverview([
			collectionOverview('a', 'id', { id: 'integer', 'b.c': 'integer' }),
			collectionOverview('a.b', 'id', { id: 'integer', c: 'integer' }),
		]);

	it('still validates a relation change on a.b / c when field a / b.c is deleted', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'a', field: 'b.c', diff: deleteDiff(field('a', 'b.c', 'integer')) }];

		diff.relations = [
			{ collection: 'a.b', field: 'c', related_collection: 'a', diff: deleteDiff(relation('a.b', 'c', 'a')) },
		];

		expect(() => assertSchemaDiffApplicable(diff, current([field('a.b', 'c', 'integer')]), overview())).toThrow(
			'Field "c" in collection "a.b" doesn\'t have a relationship.'
		);
	});

	it('accepts creating field c on collection a.b when only field b.c exists on collection a', () => {
		const diff = emptyDiff();
		diff.fields = [{ collection: 'a.b', field: 'c', diff: newDiff(field('a.b', 'c', 'integer')) }];

		const schema = schemaOverview([
			collectionOverview('a', 'id', { id: 'integer', 'b.c': 'integer' }),
			collectionOverview('a.b', 'id', { id: 'integer' }),
		]);

		expect(() => assertSchemaDiffApplicable(diff, current(), schema)).not.toThrow();
	});

	it('still refuses re-creating a metadata-only field on collection a.b when collection a is dropped', () => {
		const diff = emptyDiff();
		diff.collections = [{ collection: 'a', diff: deleteDiff(collection('a')) }];
		diff.fields = [{ collection: 'a.b', field: 'x', diff: newDiff(field('a.b', 'x', 'string')) }];

		const schema = schemaOverview([
			collectionOverview('a', 'id', { id: 'integer', 'b.c': 'integer' }),
			collectionOverview('a.b', 'id', { id: 'integer' }),
		]);

		expect(() => assertSchemaDiffApplicable(diff, current([field('a.b', 'x', 'string', null)]), schema)).toThrow(
			'Field "x" already exists in collection "a.b"'
		);
	});
});
