import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFolderId, resolveFolderReference } from './folder-id-lookup.js';

const LOWER = 'aabbccdd-eeff-4a1b-8c2d-3e4f5a6b7c8d';
const UPPER = LOWER.toUpperCase();
const OTHER = '11111111-2222-4333-8444-555555555555';

describe('isFolderId', () => {
	it('accepts a lowercase and a mixed-case uuid', () => {
		expect(isFolderId(LOWER)).toBe(true);
		expect(isFolderId(UPPER)).toBe(true);
	});

	it('rejects values that are not uuid-shaped', () => {
		expect(isFolderId('')).toBe(false);
		expect(isFolderId('not-a-folder')).toBe(false);
		expect(isFolderId('[object Object]')).toBe(false);
		expect(isFolderId(123)).toBe(false);
		expect(isFolderId(null)).toBe(false);
		expect(isFolderId(undefined)).toBe(false);
		expect(isFolderId({})).toBe(false);
	});
});

describe('resolveFolderReference on a case-sensitive column', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.schema.createTable('directus_folders', (table) => {
			table.string('id').primary();
			table.string('name');
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('returns the exact match without consulting the database', async () => {
		await db('directus_folders').insert({ id: LOWER, name: 'alpha' });
		const exact = new Map([[LOWER, 'alpha']]);
		expect(await resolveFolderReference(db, exact, LOWER)).toBe('alpha');
	});

	it('resolves a genuinely uppercase-stored id by its exact spelling', async () => {
		await db('directus_folders').insert({ id: UPPER, name: 'beta' });
		const exact = new Map([[UPPER, 'beta']]);
		expect(await resolveFolderReference(db, exact, UPPER)).toBe('beta');
	});

	it('returns undefined for a case-mismatched reference rather than inventing an alias', async () => {
		await db('directus_folders').insert({ id: LOWER, name: 'alpha' });
		const exact = new Map([[LOWER, 'alpha']]);
		expect(await resolveFolderReference(db, exact, UPPER)).toBeUndefined();
	});

	it('returns undefined for a uuid that no row denotes', async () => {
		await db('directus_folders').insert({ id: LOWER, name: 'alpha' });
		const exact = new Map([[LOWER, 'alpha']]);
		expect(await resolveFolderReference(db, exact, OTHER)).toBeUndefined();
	});
});

describe('resolveFolderReference on a case-insensitive column', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
		await db.raw('CREATE TABLE directus_folders (id TEXT PRIMARY KEY COLLATE NOCASE, name TEXT)');
		await db('directus_folders').insert({ id: LOWER, name: 'alpha' });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('confirms a mixed-case reference through the database and resolves the stored row', async () => {
		const exact = new Map([[LOWER, 'alpha']]);
		expect(await resolveFolderReference(db, exact, UPPER)).toBe('alpha');
	});
});

describe('resolveFolderReference with no folders table', () => {
	let db: Knex;

	beforeEach(() => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('never queries the database for a non-uuid or nullish reference', async () => {
		const exact = new Map([[LOWER, 'alpha']]);
		expect(await resolveFolderReference(db, exact, '')).toBeUndefined();
		expect(await resolveFolderReference(db, exact, 'not-a-folder')).toBeUndefined();
		expect(await resolveFolderReference(db, exact, String({}))).toBeUndefined();
		expect(await resolveFolderReference(db, exact, null)).toBeUndefined();
		expect(await resolveFolderReference(db, exact, undefined)).toBeUndefined();
	});

	it('returns the exact match for a nonuuid key without querying', async () => {
		const exact = new Map([['sentinel', 'kept']]);
		expect(await resolveFolderReference(db, exact, 'sentinel')).toBe('kept');
	});
});
