import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidPayloadException } from '../exceptions/index.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../utils/config-contract.js';
import { ItemsService } from './index.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

const EXISTING_FOLDER_ID = '11111111-1111-4111-8111-111111111111';

function field(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
		...extra,
	};
}

const schema = {
	collections: {
		directus_folders: {
			collection: 'directus_folders',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false, special: ['uuid'] }),
				name: field('name', 'string', { nullable: false }),
				parent: field('parent', 'uuid'),
				key: field('key', 'string', { special: ['folder-key'] }),
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

describe('directus_folders key enforcement on a real SQLite database', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 500,
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('name');
			table.uuid('parent');
			table.string('key').unique();
		});

		await db('directus_folders').insert({ id: EXISTING_FOLDER_ID, name: 'Docs', key: 'docs' });
	});

	afterEach(async () => {
		await db.destroy();
	});

	function service(): ItemsService {
		return new ItemsService('directus_folders', { knex: db, schema });
	}

	async function allFolders(): Promise<Record<string, unknown>[]> {
		return db('directus_folders').select('*').orderBy('id');
	}

	it('generates a normalized key when none is supplied', async () => {
		const id = await service().createOne({ name: 'Reports' });

		expect(await db('directus_folders').where({ id }).first()).toMatchObject({ key: 'reports', name: 'Reports' });
	});

	it('suffixes a generated key that collides with an existing folder', async () => {
		const id = await service().createOne({ name: 'Docs' });

		expect(await db('directus_folders').where({ id }).first()).toMatchObject({ key: 'docs_2' });
	});

	it('keeps a valid supplied key', async () => {
		const id = await service().createOne({ name: 'Anything', key: 'reports' });

		expect(await db('directus_folders').where({ id }).first()).toMatchObject({ key: 'reports' });
	});

	it('suffixes same-name keys within a single createMany batch', async () => {
		const ids = await service().createMany([{ name: 'Batch' }, { name: 'Batch' }, { name: 'Batch' }]);

		const rows = await db('directus_folders').whereIn('id', ids).orderBy('key');

		expect(rows.map((row) => row.key)).toEqual(['batch', 'batch_2', 'batch_3']);
	});

	it('suffixes same-name keys within a single upsertMany batch', async () => {
		const ids = await service().upsertMany([{ name: 'Upsert' }, { name: 'Upsert' }]);

		const rows = await db('directus_folders').whereIn('id', ids).orderBy('key');

		expect(rows.map((row) => row.key)).toEqual(['upsert', 'upsert_2']);
	});

	it.each([
		['null', null],
		['empty string', ''],
		['false', false],
		['zero', 0],
		['array', []],
		['object', {}],
		['non-normalized string', 'Bad Key'],
		['over the filename-stem bound', 'a'.repeat(CONFIG_FILENAME_STEM_MAX_LENGTH + 1)],
	])('refuses a malformed supplied key (%s) with INVALID_PAYLOAD and persists nothing', async (_label, value) => {
		const before = await allFolders();

		const error = await service()
			.createOne({ name: 'Rejected', key: value })
			.catch((err) => err);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.code).toBe('INVALID_PAYLOAD');

		expect(await allFolders()).toEqual(before);
	});
});

describe('directus_folders parent-cycle guard on a real SQLite database', () => {
	const A = '11111111-1111-4111-8111-111111111111';
	const B = '22222222-2222-4222-8222-222222222222';
	const C = '33333333-3333-4333-8333-333333333333';
	const D = '44444444-4444-4444-8444-444444444444';

	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 500,
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('name');
			table.uuid('parent');
			table.string('key').unique();
		});

		await db('directus_folders').insert([
			{ id: A, name: 'A', key: 'a', parent: null },
			{ id: B, name: 'B', key: 'b', parent: A },
			{ id: C, name: 'C', key: 'c', parent: B },
			{ id: D, name: 'D', key: 'd', parent: null },
		]);
	});

	afterEach(async () => {
		await db.destroy();
	});

	function service(): ItemsService {
		return new ItemsService('directus_folders', { knex: db, schema });
	}

	async function parentOf(id: string): Promise<string | null> {
		return (await db('directus_folders').where({ id }).first())!['parent'];
	}

	it('creates a folder under an existing parent', async () => {
		const id = await service().createOne({ name: 'Child', parent: A });
		expect(await parentOf(id as string)).toBe(A);
	});

	it('refuses a self-parent create and persists nothing', async () => {
		const self = '55555555-5555-4555-8555-555555555555';
		const before = await db('directus_folders').select('id');

		const error = await service()
			.createOne({ id: self, name: 'Self', parent: self })
			.catch((err) => err);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(await db('directus_folders').select('id')).toEqual(before);
	});

	it('refuses moving a folder under its own descendant', async () => {
		const error = await service()
			.updateOne(A, { parent: C })
			.catch((err) => err);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(await parentOf(A)).toBeNull();
	});

	it('refuses a self-parent update', async () => {
		const error = await service()
			.updateOne(B, { parent: B })
			.catch((err) => err);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(await parentOf(B)).toBe(A);
	});

	it('allows a valid move', async () => {
		await service().updateOne(C, { parent: D });
		expect(await parentOf(C)).toBe(D);
	});

	it('leaves a name-only update on the cheap path', async () => {
		await service().updateOne(B, { name: 'Renamed' });

		expect(await db('directus_folders').where({ id: B }).first()).toMatchObject({
			name: 'Renamed',
			key: 'b',
			parent: A,
		});
	});

	it('refuses the second of two sequential opposing moves at the runtime guard', async () => {
		await service().updateOne(A, { parent: D });

		const error = await service()
			.updateOne(D, { parent: A })
			.catch((err) => err);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(await parentOf(A)).toBe(D);
		expect(await parentOf(D)).toBeNull();
	});
});
