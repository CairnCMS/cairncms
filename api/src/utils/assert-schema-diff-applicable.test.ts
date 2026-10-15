import type { FieldOverview, SchemaOverview } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotDiff } from '../types/index.js';
import { assertSchemaDiffApplicable } from './assert-schema-diff-applicable.js';

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
});
