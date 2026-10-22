import type { Query } from '@cairncms/types';
import { parse } from 'graphql';
import type { Knex } from 'knex';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_TARGETS, observeBuiltIns } from '../../__utils__/built-ins.js';

const require = createRequire(import.meta.url);
const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/services/graphql/index.js');
const describeIfBuilt = existsSync(distPath) ? describe : describe.skip;

function field(name: string, type: string, special: string[] = []): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: null,
		precision: null,
		scale: null,
		special,
		note: null,
		validation: null,
		alias: type === 'alias',
	};
}

function collection(name: string, fields: Record<string, unknown>): Record<string, unknown> {
	return {
		collection: name,
		primary: 'id',
		singleton: false,
		sortField: null,
		note: null,
		accountability: null,
		fields,
	};
}

const defaultFields = () => ({ id: field('id', 'integer'), title: field('title', 'string') });

const schema = {
	collections: {
		directus_collections: collection('directus_collections', defaultFields()),
		directus_fields: collection('directus_fields', defaultFields()),
		directus_relations: collection('directus_relations', defaultFields()),
		deep_query_authors: collection('deep_query_authors', {
			id: field('id', 'integer'),
			name: field('name', 'string'),
			books: field('books', 'alias', ['o2m']),
		}),
		deep_query_books: collection('deep_query_books', {
			id: field('id', 'integer'),
			title: field('title', 'string'),
			author: field('author', 'integer'),
		}),
	},
	relations: [
		{
			collection: 'deep_query_books',
			field: 'author',
			related_collection: 'deep_query_authors',
			schema: null,
			meta: {
				id: 1,
				many_collection: 'deep_query_books',
				many_field: 'author',
				one_collection: 'deep_query_authors',
				one_field: 'books',
				one_collection_field: null,
				one_allowed_collections: null,
				one_deselect_action: 'nullify',
				junction_field: null,
				sort_field: null,
			},
		},
	],
};

const accountability = { user: 'admin-id', role: 'admin-role-id', admin: true, app: true, ip: '127.0.0.1' };
const knex = {} as Knex;

describeIfBuilt('GraphQL deep query construction (production-realm dist probe)', () => {
	const { GraphQLService } = require(distPath);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function run(source: string, rows: Record<string, unknown>[]) {
		const read = vi.spyOn(GraphQLService.prototype, 'read').mockResolvedValue(rows);
		const service = new GraphQLService({ accountability, knex, schema, scope: 'items' });

		const { result, changes } = await observeBuiltIns(BUILT_IN_TARGETS, () =>
			service.execute({ query: null, variables: {}, operationName: null, document: parse(source), contextValue: {} })
		);

		return { result, changes, forwarded: read.mock.calls[0]?.[1] as Query | undefined };
	}

	it('executes a nested relational query with arguments', async () => {
		const { result, forwarded } = await run('{ deep_query_books { id author { id books(limit: 1) { id } } } }', [
			{ id: 1, author: { id: 2, books: [{ id: 1 }] } },
		]);

		expect(result.errors).toBeUndefined();
		expect(result.data?.deep_query_books?.[0]?.author?.books?.[0]?.id).toBeDefined();
		expect(forwarded?.deep).toEqual({ author: { books: { _limit: 1 } } });
	});

	it('keeps an aliased built-in name in the deep query as own data without changing built-ins', async () => {
		const { result, changes, forwarded } = await run(
			'{ deep_query_books { id toString: author { id books(limit: 1) { id } } } }',
			[{ id: 1, toString: { id: 2, books: [{ id: 1 }] } }]
		);

		expect(result.errors).toBeUndefined();
		expect(result.data?.deep_query_books?.[0]?.toString?.books?.[0]?.id).toBeDefined();
		expect(forwarded?.deep).toEqual({ toString: { books: { _limit: 1 } } });
		expect(changes).toEqual([]);
	});

	it.each([
		[
			'an outer relational field',
			'{ deep_query_books { id __proto__: author { id books(limit: 1) { id } } } }',
			'[{"id":1,"__proto__":{"id":2,"books":[{"id":1}]}}]',
			'__proto__.books.id',
		],
		[
			'a nested relational field with arguments',
			'{ deep_query_books { id author { id __proto__: books(limit: 1) { id } } } }',
			'[{"id":1,"author":{"id":2,"__proto__":[{"id":1}]}}]',
			'author.__proto__.id',
		],
	])('leaves built-ins unchanged for a __proto__ alias on %s', async (_label, source, rows, field) => {
		const { changes, forwarded } = await run(source, JSON.parse(rows));

		expect(forwarded?.fields).toContain(field);
		expect(changes).toEqual([]);
	});
});
