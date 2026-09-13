import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigFolderInUseException } from '../../exceptions/index.js';
import { FolderDeletionGuard } from './folder-deletion-guard.js';

const LOWER = 'aabbccdd-eeff-4a1b-8c2d-3e4f5a6b7c8d';
const UPPER = LOWER.toUpperCase();
const OTHER = '11111111-2222-4333-8444-555555555555';

describe('FolderDeletionGuard on a real SQLite database', () => {
	let db: Knex;
	const guard = new FolderDeletionGuard();

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('name');
			table.uuid('parent');
		});

		await db.schema.createTable('directus_files', (table) => {
			table.uuid('id').primary();
			table.uuid('folder');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.uuid('storage_default_folder');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});

		await db('directus_folders').insert({ id: 'target', name: 'target', parent: null });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('passes when the folder holds no dependents', async () => {
		await expect(guard.beforeDelete(['target'], db)).resolves.toBeUndefined();
	});

	it('refuses when a file is still in the folder', async () => {
		await db('directus_files').insert({ id: 'f1', folder: 'target' });
		const error = await guard.beforeDelete(['target'], db).catch((err) => err);
		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('files');
	});

	it('refuses when a child folder remains', async () => {
		await db('directus_folders').insert({ id: 'child', name: 'child', parent: 'target' });
		const error = await guard.beforeDelete(['target'], db).catch((err) => err);
		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('folders');
	});

	it('does not count a co-deleted child as a remaining dependent', async () => {
		await db('directus_folders').insert({ id: 'child', name: 'child', parent: 'target' });
		await expect(guard.beforeDelete(['target', 'child'], db)).resolves.toBeUndefined();
	});

	it('refuses when it is the default storage folder', async () => {
		await db('directus_settings').insert({ storage_default_folder: 'target' });
		const error = await guard.beforeDelete(['target'], db).catch((err) => err);
		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('storage_default_folder');
	});

	it('refuses an options.folder reference stored as a JSON string', async () => {
		await db('directus_fields').insert({ options: JSON.stringify({ folder: 'target' }) });
		const error = await guard.beforeDelete(['target'], db).catch((err) => err);
		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('options.folder');
	});

	it('refuses an options.folder reference stored as an object', async () => {
		await db('directus_fields').insert({ options: { folder: 'target' } as never });
		const error = await guard.beforeDelete(['target'], db).catch((err) => err);
		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('options.folder');
	});

	it('ignores an options blob that references another folder', async () => {
		await db('directus_fields').insert({ options: JSON.stringify({ folder: 'other' }) });
		await expect(guard.beforeDelete(['target'], db)).resolves.toBeUndefined();
	});

	it('ignores non-uuid options.folder values without blocking or erroring', async () => {
		await db('directus_fields').insert([
			{ options: JSON.stringify({ folder: '' }) },
			{ options: JSON.stringify({ folder: 'not-a-folder' }) },
			{ options: JSON.stringify({ folder: { nested: true } }) },
			{ options: JSON.stringify({ folder: false }) },
		]);

		await expect(guard.beforeDelete(['target'], db)).resolves.toBeUndefined();
	});
});

describe('FolderDeletionGuard mixed-case reference on a case-insensitive id column', () => {
	let db: Knex;
	const guard = new FolderDeletionGuard();

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.raw('CREATE TABLE directus_folders (id TEXT PRIMARY KEY COLLATE NOCASE, name TEXT, parent TEXT)');

		await db.schema.createTable('directus_files', (table) => {
			table.uuid('id').primary();
			table.uuid('folder');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.uuid('storage_default_folder');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});

		await db('directus_folders').insert({ id: LOWER, name: 'target', parent: null });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('refuses an uppercase options.folder that denotes the deletion target', async () => {
		await db('directus_fields').insert({ options: JSON.stringify({ folder: UPPER }) });

		const error = await guard.beforeDelete([LOWER], db).catch((err) => err);
		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('options.folder');
	});

	it('does not block when the mixed-case reference denotes a different folder', async () => {
		await db('directus_folders').insert({ id: OTHER, name: 'other', parent: null });
		await db('directus_fields').insert({ options: JSON.stringify({ folder: OTHER.toUpperCase() }) });

		await expect(guard.beforeDelete([LOWER], db)).resolves.toBeUndefined();
	});
});
