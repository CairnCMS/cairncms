import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAfterCreate } from '../database/connection-hooks.js';
import type { Snapshot, SnapshotDiff } from '../types/index.js';
import { DiffKind } from '../types/index.js';
import { applyDiff } from './apply-diff.js';

const { createCollection } = vi.hoisted(() => ({ createCollection: vi.fn() }));

vi.mock('../services/collections.js', () => ({
	CollectionsService: class {
		createOne = createCollection;
	},
}));

vi.mock('../services/fields.js', () => ({ FieldsService: class {} }));
vi.mock('../services/relations.js', () => ({ RelationsService: class {} }));
vi.mock('../cache.js', () => ({ flushCaches: vi.fn() }));
vi.mock('../emitter.js', () => ({ default: { emitAction: vi.fn() } }));
vi.mock('./get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {}, relations: [] })) }));

const currentSnapshot = {
	version: 1,
	directus: '0.0.0',
	collections: [],
	fields: [],
	relations: [],
} as unknown as Snapshot;

const snapshotDiff = {
	collections: [{ collection: 'notes', diff: [{ kind: DiffKind.NEW, rhs: { collection: 'notes', meta: null } }] }],
	fields: [],
	relations: [],
} as unknown as SnapshotDiff;

const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

let database: Knex;

async function foreignKeys() {
	const rows = await database.raw('PRAGMA foreign_keys');
	return rows[0].foreign_keys;
}

beforeEach(async () => {
	createCollection.mockReset();

	database = knex.default({
		client: 'sqlite3',
		connection: { filename: ':memory:' },
		useNullAsDefault: true,
		pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate },
	});

	await database.schema.createTable('directus_folders', (table) => {
		table.uuid('id').primary();
		table.string('key');
	});

	await database('directus_folders').insert({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', key: 'images' });
});

afterEach(async () => {
	await database.destroy();
});

describe('applyDiff on SQLite', () => {
	it('turns foreign keys back on after a successful apply', async () => {
		createCollection.mockResolvedValue('notes');

		await applyDiff(currentSnapshot, structuredClone(snapshotDiff), { database, schema });

		expect(await foreignKeys()).toBe(1);
	});

	it('turns foreign keys back on after a failed apply', async () => {
		createCollection.mockRejectedValue(new Error('apply failed'));

		await expect(applyDiff(currentSnapshot, structuredClone(snapshotDiff), { database, schema })).rejects.toThrow(
			'apply failed'
		);

		expect(await foreignKeys()).toBe(1);
	});

	it('leaves foreign keys off after a failed apply when they were already off', async () => {
		await database.raw('PRAGMA foreign_keys = OFF');
		createCollection.mockRejectedValue(new Error('apply failed'));

		await expect(applyDiff(currentSnapshot, structuredClone(snapshotDiff), { database, schema })).rejects.toThrow(
			'apply failed'
		);

		expect(await foreignKeys()).toBe(0);
	});

	it('refuses a missing folder key before creating an unrelated collection', async () => {
		const diff = structuredClone(snapshotDiff);

		diff.fields = [
			{
				collection: 'articles',
				field: 'image',
				diff: [
					{
						kind: DiffKind.NEW,
						rhs: {
							collection: 'articles',
							field: 'image',
							meta: { interface: 'file', options: { folder: 'missing' } },
						},
					},
				],
			},
		] as unknown as SnapshotDiff['fields'];

		await expect(applyDiff(currentSnapshot, diff, { database, schema })).rejects.toThrow(
			'Folder reference "missing" could not be resolved. Referenced by: articles.image.meta.options.folder'
		);

		expect(createCollection).not.toHaveBeenCalled();
		expect(await foreignKeys()).toBe(1);
	});
});
