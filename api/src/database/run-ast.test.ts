import { InvalidQueryException } from '@cairncms/exceptions';
import type { Item, Query, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import env from '../env.js';
import type { AST, NestedCollectionNode } from '../types/ast.js';
import runAST, { mergeWithParentItems } from './run-ast.js';

function makeSchema(): SchemaOverview {
	return {
		collections: {
			articles: {
				collection: 'articles',
				primary: 'id',
				singleton: false,
				sortField: null,
				note: null,
				accountability: null,
				fields: {},
			},
		},
		relations: [],
	} satisfies SchemaOverview;
}

function makeO2MNode(query: Query): NestedCollectionNode {
	return {
		type: 'o2m',
		name: 'translations',
		children: [],
		query,
		fieldKey: 'translations',
		relation: {
			collection: 'translations',
			field: 'article_id',
			related_collection: 'articles',
			schema: null,
			meta: null,
		},
		parentKey: 'id',
		relatedKey: 'id',
	} satisfies NestedCollectionNode;
}

function makeChildren(count: number): Item[] {
	return Array.from({ length: count }, (_, index) => ({ id: index + 1, article_id: 1 }));
}

describe('mergeWithParentItems nested o2m pagination', () => {
	const config = env as Record<string, unknown>;
	let originalDefault: unknown;
	let originalMax: unknown;

	beforeEach(() => {
		originalDefault = config['QUERY_LIMIT_DEFAULT'];
		originalMax = config['QUERY_LIMIT_MAX'];
	});

	afterEach(() => {
		config['QUERY_LIMIT_DEFAULT'] = originalDefault;

		if (originalMax === undefined) {
			delete config['QUERY_LIMIT_MAX'];
		} else {
			config['QUERY_LIMIT_MAX'] = originalMax;
		}
	});

	test('returns every child for an unlimited nested limit on a page past the first', () => {
		config['QUERY_LIMIT_DEFAULT'] = -1;
		delete config['QUERY_LIMIT_MAX'];

		const merged = mergeWithParentItems(
			makeSchema(),
			makeChildren(3),
			{ id: 1 },
			makeO2MNode({ sort: ['id'], page: 2 })
		) as Item;

		expect((merged['translations'] as Item[]).map((child) => child['id'])).toEqual([1, 2, 3]);
	});

	test('paginates a finite nested limit past the first page', () => {
		config['QUERY_LIMIT_DEFAULT'] = 100;
		delete config['QUERY_LIMIT_MAX'];

		const merged = mergeWithParentItems(
			makeSchema(),
			makeChildren(5),
			{ id: 1 },
			makeO2MNode({ sort: ['id'], limit: 2, page: 2 })
		) as Item;

		expect((merged['translations'] as Item[]).map((child) => child['id'])).toEqual([3, 4]);
	});
});

describe('runAST accountability', () => {
	// Fails on first use, so each test can tell whether runAST reached the database.
	const database = new Proxy(
		{},
		{
			get() {
				throw new Error('database used');
			},
		}
	) as Knex;

	function makeRootAST(): AST {
		return { type: 'root', name: 'articles', children: [], query: {} };
	}

	test('rejects a missing accountability before using the database', async () => {
		const untypedRunAST = runAST as (ast: AST, schema: SchemaOverview, options?: unknown) => ReturnType<typeof runAST>;

		await expect(untypedRunAST(makeRootAST(), makeSchema())).rejects.toThrow(InvalidQueryException);
		await expect(untypedRunAST(makeRootAST(), makeSchema(), { knex: database })).rejects.toThrow(InvalidQueryException);
	});

	test('accepts an explicit null accountability and goes on to the database', async () => {
		await expect(runAST(makeRootAST(), makeSchema(), { knex: database, accountability: null })).rejects.toThrow(
			'database used'
		);
	});
});
