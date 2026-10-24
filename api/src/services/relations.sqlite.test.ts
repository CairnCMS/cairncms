import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAfterCreate } from '../database/connection-hooks.js';
import { RelationsService } from './relations.js';

vi.mock('../cache.js', () => ({
	clearSystemCache: vi.fn(),
	getCache: () => ({ systemCache: {}, cache: null, lockCache: {} }),
}));

vi.mock('../emitter.js', () => ({ default: { emitAction: vi.fn() } }));

const schema = {
	collections: {
		articles: { collection: 'articles', primary: 'id', fields: { id: {}, author: {}, editor: {} } },
		authors: { collection: 'authors', primary: 'id', fields: { id: {} } },
		editors: { collection: 'editors', primary: 'id', fields: { id: {} } },
	},
	relations: [
		{ collection: 'articles', field: 'author', related_collection: 'authors', meta: null, schema: {} },
		{ collection: 'articles', field: 'editor', related_collection: 'editors', meta: null, schema: {} },
	],
} as any;

let database: Knex;

async function referencedColumns(table: string): Promise<string[]> {
	const keys = await database.raw(`PRAGMA foreign_key_list(??)`, [table]);
	return keys.map((key: { from: string }) => key.from).sort();
}

beforeEach(async () => {
	database = knex.default({
		client: 'sqlite3',
		connection: { filename: ':memory:' },
		useNullAsDefault: true,
		pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate },
	});

	await database.schema.createTable('authors', (table) => table.increments('id'));
	await database.schema.createTable('editors', (table) => table.increments('id'));

	await database.schema.createTable('articles', (table) => {
		table.increments('id');
		table.integer('author').references('id').inTable('authors');
		table.integer('editor').references('id').inTable('editors');
	});

	await database('authors').insert({ id: 7 });
	await database('editors').insert({ id: 3 });
	await database('articles').insert({ id: 1, author: 7, editor: 3 });
});

afterEach(async () => {
	await database.destroy();
});

describe('RelationsService.deleteOne on SQLite', () => {
	it('drops the unnamed foreign key of the deleted relation and keeps the column, its data and other keys', async () => {
		expect(await referencedColumns('articles')).toEqual(['author', 'editor']);

		await database.transaction((trx) =>
			new RelationsService({ knex: trx, schema }).deleteOne('articles', 'author', {
				autoPurgeSystemCache: false,
				emitEvents: false,
			})
		);

		expect(await referencedColumns('articles')).toEqual(['editor']);
		expect(await database('articles').select('id', 'author', 'editor')).toEqual([{ id: 1, author: 7, editor: 3 }]);

		await database.schema.dropTable('authors');
		await database('articles').insert({ id: 2, author: 8, editor: 3 });

		await expect(database('articles').insert({ id: 3, author: 8, editor: 99 })).rejects.toThrow(
			'FOREIGN KEY constraint failed'
		);
	});
});
