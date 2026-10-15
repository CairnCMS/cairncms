import type { SchemaOverview } from '@cairncms/types';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigSchemaCollection } from '../../types/config.js';
import type { SnapshotField } from '../../types/index.js';
import { computeSchemaPlan } from './handlers/schema.js';
import { projectCollections } from './projected-collections.js';

vi.mock('../../env.js', async () => {
	const actual = (await vi.importActual('../../env.js')) as { default: Record<string, unknown> };
	const MOCK_ENV = { ...actual.default, DB_EXCLUDE_TABLES: ['spatial_ref_sys'] };
	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

function field(collection: string, name: string, primary = false): SnapshotField {
	return {
		collection,
		field: name,
		type: 'integer',
		meta: null,
		schema: { name, table: collection, data_type: 'integer', is_primary_key: primary, has_auto_increment: primary },
	} as unknown as SnapshotField;
}

function table(collection: string, fields: SnapshotField[]): ConfigSchemaCollection {
	return {
		collection,
		meta: null,
		schema: { name: collection } as Exclude<ConfigSchemaCollection['schema'], undefined>,
		fields,
		relations: [],
	};
}

function keyed(collection: string, ...others: string[]): ConfigSchemaCollection {
	return table(collection, [field(collection, 'id', true), ...others.map((name) => field(collection, name))]);
}

function group(collection: string): ConfigSchemaCollection {
	return {
		collection,
		meta: { collection, group: null } as Exclude<ConfigSchemaCollection['meta'], undefined>,
		fields: [],
		relations: [],
	};
}

function live(...collections: string[]): SchemaOverview['collections'] {
	return Object.fromEntries(
		collections.map((collection) => [collection, { collection, primary: 'id' }])
	) as unknown as SchemaOverview['collections'];
}

function project(current: ConfigSchemaCollection[], desired: ConfigSchemaCollection[]): Set<string> {
	const names = current.map((record) => record.collection);
	return projectCollections(live(...names), computeSchemaPlan(current, desired, []));
}

describe('projectCollections', () => {
	it('keeps the live collections when the schema plan changes nothing', () => {
		const current = [keyed('articles'), keyed('pages')];

		expect(project(current, current)).toEqual(new Set(['articles', 'pages']));
	});

	it('adds a created collection with a table and a primary key field', () => {
		expect(project([keyed('articles')], [keyed('articles'), keyed('pages', 'title')])).toEqual(
			new Set(['articles', 'pages'])
		);
	});

	it('does not add a created metadata-only group', () => {
		expect(project([keyed('articles')], [keyed('articles'), group('folder')])).toEqual(new Set(['articles']));
	});

	it('does not add a created metadata-only group that declares a primary key field', () => {
		const declared = { ...group('folder'), fields: [field('folder', 'id', true)] };

		expect(project([keyed('articles')], [keyed('articles'), declared])).toEqual(new Set(['articles']));
	});

	it('does not add a created table without a primary key field', () => {
		const unkeyed = table('logs', [field('logs', 'message')]);

		expect(project([keyed('articles')], [keyed('articles'), unkeyed])).toEqual(new Set(['articles']));
	});

	it.each(['spatial_ref_sys', 'with space', 'cairncms_extension_settings'])(
		'does not add a created collection named %s, which the runtime schema skips',
		(name) => {
			expect(project([keyed('articles')], [keyed('articles'), keyed(name)])).toEqual(new Set(['articles']));
		}
	);

	it('removes a dropped collection', () => {
		expect(project([keyed('articles'), keyed('legacy')], [keyed('articles')])).toEqual(new Set(['articles']));
	});

	it('removes a collection whose primary key field is dropped', () => {
		const withoutKey = table('articles', [field('articles', 'title')]);

		expect(project([keyed('articles', 'title')], [withoutKey])).toEqual(new Set());
	});

	it('keeps a collection whose dropped primary key field is replaced in the same plan', () => {
		const replaced = table('articles', [field('articles', 'title'), field('articles', 'uuid', true)]);

		expect(project([keyed('articles', 'title')], [replaced])).toEqual(new Set(['articles']));
	});

	it('keeps a collection whose dropped primary key field is replaced by an updated field that auto-increments', () => {
		const current = [keyed('articles', 'code')];

		const promoted = table('articles', [
			{ ...field('articles', 'code'), schema: { ...field('articles', 'code').schema, has_auto_increment: true } },
		] as SnapshotField[]);

		const overview = {
			articles: {
				collection: 'articles',
				primary: 'id',
				fields: { id: { type: 'integer' }, code: { type: 'integer' } },
			},
		} as unknown as SchemaOverview['collections'];

		expect(projectCollections(overview, computeSchemaPlan(current, [promoted], []))).toEqual(new Set(['articles']));
	});

	it('keeps a live collection whose name is an inherited object property', () => {
		expect(projectCollections(live('constructor'), { create: [], update: [], delete: [] })).toEqual(
			new Set(['constructor'])
		);
	});
});
