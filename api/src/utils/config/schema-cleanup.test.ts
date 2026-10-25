import { describe, expect, it } from 'vitest';
import type { CollectionMeta } from '../../types/collection.js';
import type {
	CairnConfig,
	ConfigPermission,
	ConfigPlan,
	ConfigSchemaCollection,
	SchemaChangeEntry,
} from '../../types/config.js';
import type { SnapshotRelation } from '../../types/index.js';
import { projectSchemaCleanup } from './schema-cleanup.js';

function config(overrides: Partial<CairnConfig> = {}): CairnConfig {
	return {
		manifest: { version: 3, resources: ['permissions', 'extension-settings', 'schema'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations: [],
		schema: [],
		...overrides,
	};
}

function meta(collection: string): CollectionMeta {
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
	};
}

function table(collection: string, relations: SnapshotRelation[] = []): ConfigSchemaCollection {
	return {
		collection,
		meta: meta(collection),
		schema: { name: collection } as Exclude<ConfigSchemaCollection['schema'], undefined>,
		fields: [],
		relations,
	};
}

function group(collection: string): ConfigSchemaCollection {
	return { collection, meta: meta(collection), fields: [], relations: [] };
}

function relation(collection: string, field: string, related: string, oneField: string | null): SnapshotRelation {
	return {
		collection,
		field,
		related_collection: related,
		meta: { one_field: oneField },
		schema: {},
	} as unknown as SnapshotRelation;
}

function permission(
	collection: string,
	fields: string[] | null,
	action: ConfigPermission['action'] = 'read'
): ConfigPermission {
	return { collection, action, permissions: null, validation: null, presets: null, fields };
}

function drops(entries: Array<{ collection: string; field?: string }>): ConfigPlan['schema'] {
	return {
		create: [],
		update: [],
		delete: entries.map(
			({ collection, field }): SchemaChangeEntry =>
				field === undefined
					? { changeKind: 'collections', identity: { collection }, changes: {} }
					: { changeKind: 'fields', identity: { collection, field }, changes: {} }
		),
	};
}

describe('projectSchemaCleanup', () => {
	it('removes permissions on a dropped collection that has a table', () => {
		const current = config({
			schema: [table('legacy'), table('articles')],
			permissions: [{ role: 'editor', permissions: [permission('legacy', ['id']), permission('articles', ['title'])] }],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'legacy' }]));

		expect(result.permissions).toEqual([{ role: 'editor', permissions: [permission('articles', ['title'])] }]);
	});

	it('keeps permissions on a dropped metadata-only group', () => {
		const current = config({
			schema: [group('folder')],
			permissions: [{ role: 'editor', permissions: [permission('folder', null)] }],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'folder' }]));

		expect(result.permissions).toEqual(current.permissions);
	});

	it('removes collection-scoped extension settings for every dropped collection', () => {
		const current = config({
			schema: [table('legacy'), group('folder'), table('articles')],
			'extension-settings': [
				{
					subject: '@cairncms/extension-widget',
					global: { color: 'red' },
					collections: { legacy: { a: '1' }, folder: { b: '2' }, articles: { c: '3' } },
				},
			],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'legacy' }, { collection: 'folder' }]));

		expect(result['extension-settings']).toEqual([
			{ subject: '@cairncms/extension-widget', global: { color: 'red' }, collections: { articles: { c: '3' } } },
		]);
	});

	it('strips a dropped field from explicit permission field lists only', () => {
		const current = config({
			schema: [table('articles'), table('pages')],
			permissions: [
				{
					role: 'editor',
					permissions: [
						permission('articles', ['title', 'body'], 'read'),
						permission('articles', ['body'], 'update'),
						permission('articles', ['*'], 'create'),
						permission('articles', null, 'delete'),
						permission('pages', ['body'], 'read'),
					],
				},
			],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'articles', field: 'body' }]));

		expect(result.permissions[0]!.permissions).toEqual([
			permission('articles', ['title'], 'read'),
			permission('articles', null, 'update'),
			permission('articles', ['*'], 'create'),
			permission('articles', null, 'delete'),
			permission('pages', ['body'], 'read'),
		]);
	});

	it('keeps relation fields on other collections when a related collection is dropped', () => {
		const current = config({
			schema: [
				table('authors'),
				table('comments', [relation('comments', 'article', 'articles', 'comments')]),
				table('articles', [relation('articles', 'author', 'authors', 'articles')]),
			],
			permissions: [{ role: 'editor', permissions: [permission('articles', ['title', 'author', 'comments'])] }],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'authors' }, { collection: 'comments' }]));

		expect(result.permissions).toEqual([
			{ role: 'editor', permissions: [permission('articles', ['title', 'author', 'comments'])] },
		]);
	});

	it('drops the paired one-to-many alias with a dropped many-to-one field', () => {
		const current = config({
			schema: [table('authors'), table('articles', [relation('articles', 'author', 'authors', 'articles')])],
			permissions: [
				{
					role: 'editor',
					permissions: [
						permission('authors', ['id', 'articles'], 'read'),
						permission('authors', ['articles'], 'update'),
						permission('articles', ['title', 'author'], 'read'),
					],
				},
			],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'articles', field: 'author' }]));

		expect(result.permissions[0]!.permissions).toEqual([
			permission('authors', ['id'], 'read'),
			permission('authors', null, 'update'),
			permission('articles', ['title'], 'read'),
		]);
	});

	it('keeps the many-to-one field when only its one-to-many alias is dropped', () => {
		const current = config({
			schema: [table('authors'), table('articles', [relation('articles', 'author', 'authors', 'articles')])],
			permissions: [
				{
					role: 'editor',
					permissions: [permission('authors', ['id', 'articles']), permission('articles', ['title', 'author'])],
				},
			],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'authors', field: 'articles' }]));

		expect(result.permissions[0]!.permissions).toEqual([
			permission('authors', ['id']),
			permission('articles', ['title', 'author']),
		]);
	});

	it('keeps the alias of a self-referencing many-to-one field', () => {
		const current = config({
			schema: [table('pages', [relation('pages', 'parent', 'pages', 'children')])],
			permissions: [{ role: 'editor', permissions: [permission('pages', ['title', 'parent', 'children'])] }],
		});

		const result = projectSchemaCleanup(current, drops([{ collection: 'pages', field: 'parent' }]));

		expect(result.permissions[0]!.permissions).toEqual([permission('pages', ['title', 'children'])]);
	});

	it('returns the current configuration unchanged when the schema plan drops nothing', () => {
		const current = config({
			schema: [table('articles')],
			permissions: [{ role: 'editor', permissions: [permission('articles', ['title'])] }],
		});

		expect(projectSchemaCleanup(current, { create: [], update: [], delete: [] })).toBe(current);
	});
});
