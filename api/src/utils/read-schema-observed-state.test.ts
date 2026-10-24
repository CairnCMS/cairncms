import type { Knex } from 'knex';
import { describe, expect, it } from 'vitest';
import type { SchemaPersistedState } from '../types/index.js';
import {
	readSchemaObservedState,
	schemaStateVerifiedReverted,
	type SchemaTouchedEntities,
} from './read-schema-observed-state.js';

type StubState = {
	tables?: string[];
	columns?: Array<[string, string]>;
	rows?: Record<string, Record<string, string>[]>;
	throwOnTable?: string;
};

function stubDatabase(state: StubState): Knex {
	const tables = new Set(state.tables ?? []);
	const columns = state.columns ?? [];
	const rows = state.rows ?? {};

	const database = ((table: string) => ({
		where: (where: Record<string, string>) => ({
			first: async () =>
				(rows[table] ?? []).find((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
		}),
	})) as unknown as Knex;

	(database as any).schema = {
		hasTable: async (table: string) => {
			if (state.throwOnTable === table) throw new Error('inspection unavailable');
			return tables.has(table);
		},
		hasColumn: async (table: string, column: string) =>
			columns.some(([owner, name]) => owner === table && name === column),
	};

	return database;
}

const empty: SchemaTouchedEntities = { collections: [], fields: [], relations: [] };

describe('readSchemaObservedState', () => {
	it('reports an applicable create as applied when present and reverted when absent', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({
				tables: ['articles'],
				columns: [['articles', 'title']],
				rows: {
					directus_collections: [{ collection: 'articles' }],
					directus_fields: [{ collection: 'articles', field: 'title' }],
					directus_relations: [{ many_collection: 'articles', many_field: 'author' }],
				},
			}),
			{
				collections: [
					{ collection: 'articles', operation: 'create', table: 'yes', metadata: 'yes' },
					{ collection: 'ghost', operation: 'create', table: 'yes', metadata: 'yes' },
				],
				fields: [{ collection: 'articles', field: 'title', operation: 'create', column: 'yes', metadata: 'yes' }],
				relations: [{ collection: 'articles', field: 'author', operation: 'create', metadata: 'yes' }],
			}
		);

		expect(observed.collections).toEqual([
			{ collection: 'articles', operation: 'create', table: 'applied', metadata: 'applied' },
			{ collection: 'ghost', operation: 'create', table: 'reverted', metadata: 'reverted' },
		]);

		expect(observed.fields).toEqual([
			{ collection: 'articles', field: 'title', operation: 'create', column: 'applied', metadata: 'applied' },
		]);

		expect(observed.relations).toEqual([
			{ collection: 'articles', field: 'author', operation: 'create', foreignKey: 'unknown', metadata: 'applied' },
		]);
	});

	it('reports an alias column as not_applicable even when absent', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({ rows: { directus_fields: [{ collection: 'articles', field: 'authors' }] } }),
			{
				...empty,
				fields: [{ collection: 'articles', field: 'authors', operation: 'delete', column: 'no', metadata: 'yes' }],
			}
		);

		expect(observed.fields[0]).toEqual({
			collection: 'articles',
			field: 'authors',
			operation: 'delete',
			column: 'not_applicable',
			metadata: 'reverted',
		});
	});

	it('reports a database-only field metadata as not_applicable while its surviving column is reverted', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({ tables: ['articles'], columns: [['articles', 'legacy']] }),
			{
				...empty,
				fields: [{ collection: 'articles', field: 'legacy', operation: 'delete', column: 'yes', metadata: 'no' }],
			}
		);

		expect(observed.fields[0]).toMatchObject({ column: 'reverted', metadata: 'not_applicable' });
	});

	it('keeps an uncertain metadata facet unknown', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({ tables: ['articles'], columns: [['articles', 'stamp']] }),
			{
				...empty,
				fields: [{ collection: 'articles', field: 'stamp', operation: 'create', column: 'yes', metadata: 'unknown' }],
			}
		);

		expect(observed.fields[0]).toMatchObject({ column: 'applied', metadata: 'unknown' });
	});

	it('reports a native relation deletion metadata as not_applicable', async () => {
		const observed = await readSchemaObservedState(stubDatabase({}), {
			...empty,
			relations: [{ collection: 'articles', field: 'author', operation: 'delete', metadata: 'no' }],
		});

		expect(observed.relations[0]).toEqual({
			collection: 'articles',
			field: 'author',
			operation: 'delete',
			foreignKey: 'unknown',
			metadata: 'not_applicable',
		});
	});

	it('reports a metadata-only group table as not_applicable', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({ rows: { directus_collections: [{ collection: 'group' }] } }),
			{
				...empty,
				collections: [{ collection: 'group', operation: 'delete', table: 'no', metadata: 'yes' }],
			}
		);

		expect(observed.collections[0]).toEqual({
			collection: 'group',
			operation: 'delete',
			table: 'not_applicable',
			metadata: 'reverted',
		});
	});

	it('reports a delete as applied when absent and reverted when the physical entity survives', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({ tables: ['kept'], rows: { directus_collections: [{ collection: 'kept' }] } }),
			{
				...empty,
				collections: [
					{ collection: 'kept', operation: 'delete', table: 'yes', metadata: 'yes' },
					{ collection: 'dropped', operation: 'delete', table: 'yes', metadata: 'yes' },
				],
			}
		);

		expect(observed.collections).toEqual([
			{ collection: 'kept', operation: 'delete', table: 'reverted', metadata: 'reverted' },
			{ collection: 'dropped', operation: 'delete', table: 'applied', metadata: 'applied' },
		]);
	});

	it('marks an update unknown without inspecting the database', async () => {
		const observed = await readSchemaObservedState(stubDatabase({ throwOnTable: 'articles' }), {
			...empty,
			collections: [{ collection: 'articles', operation: 'update', table: 'yes', metadata: 'yes' }],
			fields: [{ collection: 'articles', field: 'title', operation: 'update', column: 'yes', metadata: 'yes' }],
		});

		expect(observed.collections[0]).toMatchObject({ table: 'unknown', metadata: 'unknown' });
		expect(observed.fields[0]).toMatchObject({ column: 'unknown', metadata: 'unknown' });
	});

	it('reports fields a / b.c and a.b / c separately, so a persisted deletion is not hidden', async () => {
		const observed = await readSchemaObservedState(
			stubDatabase({
				tables: ['a', 'a.b'],
				columns: [['a', 'b.c']],
				rows: { directus_fields: [{ collection: 'a', field: 'b.c' }] },
			}),
			{
				...empty,
				fields: [
					{ collection: 'a', field: 'b.c', operation: 'delete', column: 'yes', metadata: 'yes' },
					{ collection: 'a.b', field: 'c', operation: 'delete', column: 'yes', metadata: 'yes' },
				],
			}
		);

		expect(observed.fields).toEqual([
			{ collection: 'a', field: 'b.c', operation: 'delete', column: 'reverted', metadata: 'reverted' },
			{ collection: 'a.b', field: 'c', operation: 'delete', column: 'applied', metadata: 'applied' },
		]);

		expect(schemaStateVerifiedReverted(observed)).toBe(false);
	});

	it('propagates a read failure so the caller can report an unknown outcome', async () => {
		await expect(
			readSchemaObservedState(stubDatabase({ throwOnTable: 'articles' }), {
				...empty,
				collections: [{ collection: 'articles', operation: 'create', table: 'yes', metadata: 'yes' }],
			})
		).rejects.toThrow('inspection unavailable');
	});
});

describe('schemaStateVerifiedReverted', () => {
	const blank: SchemaPersistedState = { collections: [], fields: [], relations: [] };

	it('is true when every facet reverted or is not applicable', () => {
		const state: SchemaPersistedState = {
			...blank,
			collections: [{ collection: 'a', operation: 'create', table: 'reverted', metadata: 'reverted' }],
			fields: [
				{ collection: 'a', field: 'alias', operation: 'delete', column: 'not_applicable', metadata: 'reverted' },
			],
		};

		expect(schemaStateVerifiedReverted(state)).toBe(true);
	});

	it('is false when any facet applied', () => {
		const state: SchemaPersistedState = {
			...blank,
			collections: [{ collection: 'a', operation: 'create', table: 'applied', metadata: 'reverted' }],
		};

		expect(schemaStateVerifiedReverted(state)).toBe(false);
	});

	it('is false when any facet is unknown, preserving uncertainty', () => {
		const state: SchemaPersistedState = {
			...blank,
			fields: [{ collection: 'a', field: 'x', operation: 'create', column: 'reverted', metadata: 'unknown' }],
		};

		expect(schemaStateVerifiedReverted(state)).toBe(false);
	});
});
