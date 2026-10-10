import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot, SnapshotDiff, SnapshotField } from '../types/index.js';
import { applyDiff } from './apply-diff.js';
import { applySnapshot } from './apply-snapshot.js';
import { getSnapshot } from './get-snapshot.js';
import { getSnapshotDiff } from './get-snapshot-diff.js';

vi.mock('./apply-diff.js', () => ({ applyDiff: vi.fn(async () => undefined) }));
vi.mock('./get-snapshot.js', () => ({ getSnapshot: vi.fn() }));
vi.mock('./get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {}, relations: [] })) }));
vi.mock('../cache.js', () => ({ getCache: () => ({ systemCache: { clear: vi.fn() } }) }));

const IMAGES = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function uploads(folder: string, version = 1): Snapshot {
	const field = {
		collection: 'articles',
		field: 'image',
		type: 'uuid',
		schema: null,
		meta: { interface: 'file', options: { folder } },
	} as unknown as SnapshotField;

	const header = version === 2 ? { version, release: '1.0.0' } : { version, directus: '1.0.0' };
	return { ...header, collections: [], fields: [field], relations: [] } as unknown as Snapshot;
}

let database: Knex;

beforeEach(async () => {
	database = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

	await database.schema.createTable('directus_folders', (table) => {
		table.uuid('id').primary();
		table.string('key');
	});

	await database('directus_folders').insert({ id: IMAGES, key: 'images' });
	vi.mocked(getSnapshot).mockResolvedValue(uploads(IMAGES));
});

afterEach(async () => {
	await database.destroy();
	vi.clearAllMocks();
});

describe('applySnapshot on a real SQLite database', () => {
	it('diffs a version 1 snapshot against the stored state, as before', async () => {
		await applySnapshot(uploads(OTHER), { database });

		expect(vi.mocked(applyDiff).mock.calls[0]![1]).toEqual(getSnapshotDiff(uploads(IMAGES), uploads(OTHER)));
	});

	it('compares a version 2 snapshot by folder key', async () => {
		await applySnapshot(uploads('images', 2), { database });

		expect(vi.mocked(applyDiff).mock.calls[0]![1]).toEqual({ collections: [], fields: [], relations: [] });
	});

	it('refuses an invalid version 2 reference before applying', async () => {
		await expect(applySnapshot(uploads('missing', 2), { database })).rejects.toThrow(
			'Folder reference "missing" could not be resolved. Referenced by: articles.image.meta.options.folder'
		);

		await expect(applySnapshot(uploads(OTHER, 2), { database })).rejects.toThrow('is not a folder key');

		expect(applyDiff).not.toHaveBeenCalled();
	});

	it('refuses an unsupported or quoted version', async () => {
		await expect(applySnapshot(uploads(IMAGES, 3), { database })).rejects.toThrow('"version" must be one of [1, 2]');

		await expect(applySnapshot({ ...uploads(IMAGES), version: '1' } as any, { database })).rejects.toThrow(
			'"version" must be one of [1, 2]'
		);

		expect(applyDiff).not.toHaveBeenCalled();
	});

	it('uses a supplied current state and a supplied diff as given', async () => {
		const current = uploads(OTHER);
		const diff: SnapshotDiff = { collections: [], fields: [], relations: [] };

		await applySnapshot(uploads('images', 2), { database, current, diff });

		expect(getSnapshot).not.toHaveBeenCalled();
		expect(vi.mocked(applyDiff).mock.calls[0]![0]).toBe(current);
		expect(vi.mocked(applyDiff).mock.calls[0]![1]).toBe(diff);
	});

	it('diffs against a supplied current state when no diff is supplied', async () => {
		await applySnapshot(uploads('images', 2), { database, current: uploads(OTHER) });

		expect(getSnapshot).not.toHaveBeenCalled();
		expect(vi.mocked(applyDiff).mock.calls[0]![1].fields[0]!.diff[0]).toMatchObject({ kind: 'E', rhs: 'images' });
	});
});
