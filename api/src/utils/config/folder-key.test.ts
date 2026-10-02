import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFolderKey } from './folder-key.js';

describe('resolveFolderKey', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			useNullAsDefault: true,
			connection: ':memory:',
			pool: { min: 1, max: 1 },
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.string('id').primary();
			table.string('name');
			table.string('key');
		});

		await db('directus_folders').insert([{ id: 'f-a', name: 'Docs', key: 'docs' }]);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('generates a normalized key from the name when none is supplied', async () => {
		expect(await resolveFolderKey({ action: 'create', value: undefined, name: 'New Folder', knex: db })).toBe(
			'new_folder'
		);
	});

	it('suffixes a generated key that collides with an existing one', async () => {
		expect(await resolveFolderKey({ action: 'create', value: undefined, name: 'Docs', knex: db })).toBe('docs_2');
	});

	it('falls back when the name normalizes to empty', async () => {
		expect(await resolveFolderKey({ action: 'create', value: undefined, name: '!!!', knex: db })).toBe('folder');
	});

	it('keeps a supplied key that is already a valid normalized key', async () => {
		expect(await resolveFolderKey({ action: 'create', value: 'reports', name: 'Anything', knex: db })).toBe('reports');
	});

	it('generates only when the key is strictly absent', async () => {
		expect(await resolveFolderKey({ action: 'create', value: undefined, name: 'Reports', knex: db })).toBe('reports');
	});

	it('returns the value unchanged on update', async () => {
		expect(await resolveFolderKey({ action: 'update', value: 'docs', name: 'Docs', knex: db })).toBe('docs');
	});
});
