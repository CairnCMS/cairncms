import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaStateChangedException } from '../exceptions/schema-state-changed.js';
import type { Snapshot, SnapshotDiff, SnapshotField } from '../types/index.js';
import { applyDiff } from './apply-diff.js';
import { toKeyFormSnapshot } from './folder-references.js';
import { getSnapshot } from './get-snapshot.js';
import { getVersionedHash } from './get-versioned-hash.js';

const { createCollection, updateFieldFn } = vi.hoisted(() => ({ createCollection: vi.fn(), updateFieldFn: vi.fn() }));

vi.mock('../services/collections.js', () => ({
	CollectionsService: class {
		createOne = createCollection;
		updateOne = vi.fn();
		deleteOne = vi.fn();
	},
}));

vi.mock('../services/fields.js', () => ({
	FieldsService: class {
		createField = vi.fn();
		updateField = updateFieldFn;
		deleteField = vi.fn();
	},
}));

vi.mock('../services/relations.js', () => ({
	RelationsService: class {
		createOne = vi.fn();
		updateOne = vi.fn();
		deleteOne = vi.fn();
	},
}));

vi.mock('../cache.js', () => ({ flushCaches: vi.fn() }));
vi.mock('../emitter.js', () => ({ default: { emitAction: vi.fn() } }));
vi.mock('../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('./get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {}, relations: [] })) }));
vi.mock('./get-snapshot.js', () => ({ getSnapshot: vi.fn() }));

vi.mock('../database/helpers/index.js', () => ({
	getHelpers: () => ({ schema: { preColumnChange: async () => false, postColumnChange: async () => undefined } }),
}));

const IMAGES_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REPLACED_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

function uploadsSnapshot(folderId: string, note: string | null = null): Snapshot {
	return {
		version: 1,
		directus: '1.0.0',
		collections: [],
		fields: [
			{
				collection: 'articles',
				field: 'image',
				type: 'uuid',
				schema: null,
				meta: { collection: 'articles', field: 'image', interface: 'file', note, options: { folder: folderId } },
			} as unknown as SnapshotField,
		],
		relations: [],
	};
}

let database: Knex;

beforeEach(async () => {
	vi.clearAllMocks();

	database = knex.default({
		client: 'sqlite3',
		connection: { filename: ':memory:' },
		useNullAsDefault: true,
		pool: { min: 1, max: 1 },
	});

	await database.schema.createTable('directus_folders', (table) => {
		table.uuid('id').primary();
		table.string('key');
	});
});

afterEach(async () => {
	await database.destroy();
});

describe('applyDiff recheck with real hashing', () => {
	it('refuses with SchemaStateChangedException before any write when the schema changed after planning', async () => {
		await database('directus_folders').insert({ id: IMAGES_ID, key: 'images' });

		const planned = uploadsSnapshot(IMAGES_ID);
		const plannedHash = getVersionedHash((await toKeyFormSnapshot(planned, { database })).snapshot);

		// the live schema has diverged since planning, so its key-form hash no longer matches
		vi.mocked(getSnapshot).mockResolvedValue(uploadsSnapshot(IMAGES_ID, 'Edited after planning'));

		const diff: SnapshotDiff = {
			collections: [{ collection: 'notes', diff: [{ kind: 'N', rhs: { collection: 'notes', meta: null } } as any] }],
			fields: [],
			relations: [],
		};

		await expect(applyDiff(diff, { database, expectedHash: plannedHash })).rejects.toBeInstanceOf(
			SchemaStateChangedException
		);

		expect(createCollection).not.toHaveBeenCalled();
	});

	it('applies a note-only update to the fresh folder id after a same-key folder replacement', async () => {
		// the plan was computed while key "images" resolved to the original local id
		await database('directus_folders').insert({ id: IMAGES_ID, key: 'images' });
		const planned = uploadsSnapshot(IMAGES_ID);
		const planningHash = getVersionedHash((await toKeyFormSnapshot(planned, { database })).snapshot);

		// the folder behind "images" is then replaced, so the live row points at a new local id
		await database('directus_folders').where('id', IMAGES_ID).delete();
		await database('directus_folders').insert({ id: REPLACED_ID, key: 'images' });

		const live = uploadsSnapshot(REPLACED_ID);
		const freshHash = getVersionedHash((await toKeyFormSnapshot(live, { database })).snapshot);

		// the local-id swap does not change the portable key-form hash, so the plan is not stale
		expect(freshHash).toBe(planningHash);

		vi.mocked(getSnapshot).mockResolvedValue(live);

		const diff: SnapshotDiff = {
			collections: [],
			fields: [
				{
					collection: 'articles',
					field: 'image',
					diff: [{ kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Hero image' } as any],
				},
			],
			relations: [],
		};

		await applyDiff(diff, { database, expectedHash: planningHash });

		// the snapshot the execution uses is read inside the transaction, not from a non-transactional handle
		const [readArgs] = vi.mocked(getSnapshot).mock.calls[0]!;
		expect(typeof (readArgs as { database: Knex.Transaction }).database.commit).toBe('function');

		expect(updateFieldFn).toHaveBeenCalledOnce();

		const written = updateFieldFn.mock.calls[0]![1] as SnapshotField;
		expect(written.meta.options).toEqual({ folder: REPLACED_ID });
		expect(written.meta.note).toBe('Hero image');
	});
});
