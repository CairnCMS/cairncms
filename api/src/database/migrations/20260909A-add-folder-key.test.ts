import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { down, up } from './20260909A-add-folder-key.js';

const MAX = 246;

const FIXTURE = [
	{ id: 'f-a', name: 'Docs', parent: null },
	{ id: 'f-b', name: 'Docs', parent: 'f-a' },
	{ id: 'f-c', name: 'Images', parent: null },
	{ id: 'f-d', name: '!!!', parent: null },
	{ id: 'f-e', name: '@@@', parent: null },
	{ id: 'f-g', name: 'x'.repeat(255), parent: null },
	{ id: 'f-h', name: 'x'.repeat(255), parent: null },
];

describe('20260909A-add-folder-key', () => {
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
			table.string('parent');
		});

		// Insert out of id order so the test proves backfill orders by id, not by insertion.
		await db('directus_folders').insert([
			FIXTURE[6],
			FIXTURE[2],
			FIXTURE[0],
			FIXTURE[4],
			FIXTURE[1],
			FIXTURE[5],
			FIXTURE[3],
		]);
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function keysById(): Promise<Record<string, string>> {
		const rows = await db('directus_folders').select('id', 'key');
		return Object.fromEntries(rows.map((row) => [row.id, row.key]));
	}

	it('backfills deterministic keys in id order, deduping collisions, empty slugs, and long names', async () => {
		await up(db);

		expect(await keysById()).toEqual({
			'f-a': 'docs',
			'f-b': 'docs_2',
			'f-c': 'images',
			'f-d': 'folder',
			'f-e': 'folder_2',
			'f-g': 'x'.repeat(MAX),
			'f-h': 'x'.repeat(MAX - 2) + '_2',
		});

		expect(Object.values(await keysById()).every((key) => key.length <= MAX)).toBe(true);
	});

	it('preserves ids, names, and parent relationships', async () => {
		await up(db);

		const rows = await db('directus_folders').select('id', 'name', 'parent').orderBy('id', 'asc');

		expect(rows).toEqual([...FIXTURE].sort((a, b) => a.id.localeCompare(b.id)));
	});

	it('enforces non-null and unique on the key after migration', async () => {
		await up(db);

		await expect(db('directus_folders').insert({ id: 'f-null', name: 'No Key', parent: null })).rejects.toThrow();

		await expect(
			db('directus_folders').insert({ id: 'f-dup', name: 'Dup', parent: null, key: 'docs' })
		).rejects.toThrow();
	});

	it('drops the key column on rollback, leaving folders intact', async () => {
		await up(db);
		await down(db);

		expect(await db('directus_folders').columnInfo()).not.toHaveProperty('key');

		const rows = await db('directus_folders').select('id', 'name', 'parent').orderBy('id', 'asc');

		expect(rows).toEqual([...FIXTURE].sort((a, b) => a.id.localeCompare(b.id)));
	});

	it('derives literal golden keys independent of the runtime bound', async () => {
		await db('directus_folders').del();

		const golden = [
			{ id: 'g01', name: 'Hello, World!', parent: null },
			{ id: 'g02', name: '123 Reports', parent: null },
			{ id: 'g03', name: 'Cafe' + String.fromCharCode(0x0301), parent: null },
			{ id: 'g04', name: String.fromCharCode(0xfb01) + 'le', parent: null },
			{ id: 'g05', name: 'Images', parent: null },
			{ id: 'g06', name: 'images', parent: null },
			{ id: 'g07', name: 'IMAGES', parent: null },
			{ id: 'g08', name: '!!!', parent: null },
			{ id: 'g09', name: '@@@', parent: null },
			{ id: 'g10', name: 'a'.repeat(243) + ' b', parent: null },
			{ id: 'g11', name: 'a'.repeat(243) + ' b', parent: null },
		];

		await db('directus_folders').insert(golden);
		await up(db);

		expect(await keysById()).toEqual({
			g01: 'hello_world',
			g02: 'reports',
			g03: 'cafe',
			g04: 'file',
			g05: 'images',
			g06: 'images_2',
			g07: 'images_3',
			g08: 'folder',
			g09: 'folder_2',
			g10: 'a'.repeat(243) + '_b',
			g11: 'a'.repeat(243) + '_2',
		});
	});

	it('completes on an empty folders table', async () => {
		await db('directus_folders').del();
		await up(db);

		expect(await db('directus_folders').select('id')).toEqual([]);
		await expect(db('directus_folders').insert({ id: 'x', name: 'X', parent: null })).rejects.toThrow();
	});
});

describe('20260909A-add-folder-key foreign-key preservation', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			useNullAsDefault: true,
			connection: ':memory:',
			pool: { min: 1, max: 1 },
		});

		await db.raw('PRAGMA foreign_keys = ON');

		await db.schema.createTable('directus_folders', (table) => {
			table.string('id').primary();
			table.string('name');
			table.string('parent').references('id').inTable('directus_folders');
		});

		await db.schema.createTable('directus_files', (table) => {
			table.string('id').primary();
			table.string('folder').references('id').inTable('directus_folders');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.string('storage_default_folder').references('id').inTable('directus_folders');
		});

		await db('directus_folders').insert([
			{ id: 'root', name: 'Root', parent: null },
			{ id: 'child', name: 'Child', parent: 'root' },
		]);

		await db('directus_files').insert({ id: 'file-1', folder: 'child' });
		await db('directus_settings').insert({ storage_default_folder: 'root' });
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function references(): Promise<Record<string, unknown>> {
		return {
			folders: await db('directus_folders').select('id', 'name', 'parent').orderBy('id', 'asc'),
			file: await db('directus_files').where({ id: 'file-1' }).first('id', 'folder'),
			setting: await db('directus_settings').first('storage_default_folder'),
		};
	}

	it('preserves parent, file, and settings references with FK enforcement across up and down', async () => {
		const before = await references();

		await up(db);
		expect(await references()).toEqual(before);

		await down(db);
		expect(await references()).toEqual(before);
	});
});
