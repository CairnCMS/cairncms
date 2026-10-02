import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFolderDeletionImpact } from './folders-impact.js';

type Update = { key: string; changes: { parent?: unknown } };

function plan(deletes: string[], updates: Update[] = []): { create: never[]; update: Update[]; delete: string[] } {
	return { create: [], update: updates, delete: deletes };
}

const LOWER = 'aabbccdd-eeff-4a1b-8c2d-3e4f5a6b7c8d';
const UPPER = LOWER.toUpperCase();

describe('readFolderDeletionImpact on real SQLite', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.schema.createTable('directus_folders', (table) => {
			table.string('id').primary();
			table.string('key');
			table.string('parent');
		});

		await db.schema.createTable('directus_files', (table) => {
			table.string('id').primary();
			table.string('folder');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.string('storage_default_folder');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function seedFolders(entries: Array<{ id: string; key: string; parent: string | null }>): Promise<void> {
		await db('directus_folders').insert(entries);
	}

	it('reports a folder that still holds a file', async () => {
		await seedFolders([{ id: 'id-a', key: 'a', parent: null }]);
		await db('directus_files').insert({ id: 'file-1', folder: 'id-a' });

		expect((await readFolderDeletionImpact(plan(['a']), db)).get('a')).toEqual([{ blockedBy: 'files' }]);
	});

	it('reports a remaining child but not one the same plan deletes or reparents away', async () => {
		await seedFolders([
			{ id: 'id-a', key: 'a', parent: null },
			{ id: 'id-b', key: 'b', parent: 'id-a' },
		]);

		expect((await readFolderDeletionImpact(plan(['a']), db)).get('a')).toEqual([{ blockedBy: 'folders' }]);
		expect((await readFolderDeletionImpact(plan(['a', 'b']), db)).get('a')).toEqual([]);

		const reparent = plan(['a'], [{ key: 'b', changes: { parent: { before: 'id-a', after: null } } }]);
		expect((await readFolderDeletionImpact(reparent, db)).get('a')).toEqual([]);
	});

	it('reports a storage_default_folder reference', async () => {
		await seedFolders([{ id: 'id-a', key: 'a', parent: null }]);
		await db('directus_settings').insert({ storage_default_folder: 'id-a' });

		expect((await readFolderDeletionImpact(plan(['a']), db)).get('a')).toEqual([
			{ blockedBy: 'storage_default_folder' },
		]);
	});

	it('reports an options.folder reference stored as JSON text', async () => {
		await seedFolders([{ id: 'id-a', key: 'a', parent: null }]);
		await db('directus_fields').insert({ options: JSON.stringify({ folder: 'id-a' }) });

		expect((await readFolderDeletionImpact(plan(['a']), db)).get('a')).toEqual([{ blockedBy: 'options.folder' }]);
	});

	it('ignores non-uuid options.folder values', async () => {
		await seedFolders([{ id: 'id-a', key: 'a', parent: null }]);

		await db('directus_fields').insert([
			{ options: JSON.stringify({ folder: '' }) },
			{ options: JSON.stringify({ folder: 'not-a-folder' }) },
			{ options: JSON.stringify({ folder: { nested: true } }) },
		]);

		expect((await readFolderDeletionImpact(plan(['a']), db)).get('a')).toEqual([]);
	});

	it('reports nothing for a clean folder and orders multiple blockers', async () => {
		await seedFolders([
			{ id: 'id-a', key: 'a', parent: null },
			{ id: 'id-clean', key: 'clean', parent: null },
			{ id: 'id-child', key: 'child', parent: 'id-a' },
		]);

		await db('directus_files').insert({ id: 'file-1', folder: 'id-a' });
		await db('directus_settings').insert({ storage_default_folder: 'id-a' });

		expect((await readFolderDeletionImpact(plan(['clean']), db)).get('clean')).toEqual([]);

		expect((await readFolderDeletionImpact(plan(['a']), db)).get('a')).toEqual([
			{ blockedBy: 'files' },
			{ blockedBy: 'folders' },
			{ blockedBy: 'storage_default_folder' },
		]);
	});
});

describe('readFolderDeletionImpact mixed-case options.folder on a case-insensitive column', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.raw('CREATE TABLE directus_folders (id TEXT PRIMARY KEY COLLATE NOCASE, key TEXT, parent TEXT)');

		await db.schema.createTable('directus_files', (table) => {
			table.string('id').primary();
			table.string('folder');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.string('storage_default_folder');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});

		await db('directus_folders').insert({ id: LOWER, key: 'target', parent: null });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('reports an uppercase options.folder that denotes the deletion target', async () => {
		await db('directus_fields').insert({ options: JSON.stringify({ folder: UPPER }) });

		expect((await readFolderDeletionImpact(plan(['target']), db)).get('target')).toEqual([
			{ blockedBy: 'options.folder' },
		]);
	});
});
