import type { Diff } from 'deep-diff';
import knex from 'knex';
import type { Knex } from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaService } from './schema.js';
import { ForbiddenException } from '../exceptions/forbidden.js';
import type { Collection } from '../types/collection.js';
import type { PortableSnapshot, Snapshot, SnapshotDiffWithHash } from '../types/snapshot.js';
import { applyDiff } from '../utils/apply-diff.js';
import { getSnapshot } from '../utils/get-snapshot.js';

vi.mock('../utils/package.js', () => ({ version: '0.0.0' }));

vi.mock('../../src/database/index.js', () => {
	return { __esModule: true, default: vi.fn(), getDatabaseClient: vi.fn().mockReturnValue('postgres') };
});

vi.mock('../utils/get-snapshot.js', () => ({
	getSnapshot: vi.fn(),
}));

vi.mock('../utils/apply-diff.js', () => ({
	applyDiff: vi.fn(),
}));

class Client_PG extends MockClient {}

let db: Knex;
let tracker: Tracker;

const testSnapshot = {
	directus: '0.0.0',
	version: 1,
	vendor: 'postgres',
	collections: [],
	fields: [],
	relations: [],
} satisfies Snapshot;

const testCollectionDiff = {
	collection: 'test',
	diff: [
		{
			kind: 'N',
			rhs: {
				collection: 'test',
				meta: {
					accountability: 'all',
					collection: 'test',
					group: null,
					hidden: false,
					icon: null,
					item_duplication_fields: null,
					note: null,
					singleton: false,
					translations: {},
				},
				schema: { name: 'test' },
			},
		},
	] satisfies Diff<Collection>[],
};

beforeAll(() => {
	db = knex.default({ client: Client_PG });
	tracker = createTracker(db);
});

beforeEach(() => {
	tracker.on.select('directus_folders').response([{ id: FOLDER_ID, key: 'images' }]);
});

afterEach(() => {
	tracker.reset();
	vi.clearAllMocks();
});

const FOLDER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function uploadFields(folder: string) {
	return [
		{
			collection: 'articles',
			field: 'image',
			type: 'uuid',
			schema: null,
			meta: { collection: 'articles', field: 'image', interface: 'file', options: { folder } },
		},
	];
}

function snapshotWithUploadField(folder: string): Snapshot {
	return { ...testSnapshot, fields: uploadFields(folder) } as unknown as Snapshot;
}

function portableWithUploadField(folder: string): PortableSnapshot {
	const { directus: _directus, ...rest } = testSnapshot;
	return { ...rest, version: 2, release: '0.0.0', fields: uploadFields(folder) } as unknown as PortableSnapshot;
}

describe('Services / Schema', () => {
	describe('snapshot', () => {
		it('should throw ForbiddenException for non-admin user', async () => {
			vi.mocked(getSnapshot).mockResolvedValueOnce(testSnapshot);

			const service = new SchemaService({ knex: db, accountability: { role: 'test', admin: false } });

			await expect(service.snapshot()).rejects.toThrowError(ForbiddenException);
		});

		it('should return snapshot for admin user', async () => {
			vi.mocked(getSnapshot).mockResolvedValueOnce(testSnapshot);

			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await expect(service.snapshot()).resolves.toEqual(testSnapshot);
		});

		it('should return a version 2 snapshot with folder keys on request', async () => {
			vi.mocked(getSnapshot).mockReset().mockResolvedValueOnce(snapshotWithUploadField(FOLDER_ID));

			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await expect(service.snapshot({ version: 2 })).resolves.toEqual(portableWithUploadField('images'));
		});
	});

	describe('apply', () => {
		const snapshotDiffWithHash = {
			hash: '813b3cdf7013310fafde7813b7d5e6bd4eb1e73f',
			diff: {
				collections: [testCollectionDiff],
				fields: [],
				relations: [],
			},
		} satisfies SnapshotDiffWithHash;

		it('should throw ForbiddenException for non-admin user', async () => {
			vi.mocked(getSnapshot).mockResolvedValueOnce(testSnapshot);

			const service = new SchemaService({ knex: db, accountability: { role: 'test', admin: false } });

			await expect(service.apply(snapshotDiffWithHash)).rejects.toThrowError(ForbiddenException);
			expect(vi.mocked(applyDiff)).not.toHaveBeenCalledOnce();
		});

		it('should apply for admin user', async () => {
			vi.mocked(getSnapshot).mockResolvedValueOnce(testSnapshot);

			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await service.apply(snapshotDiffWithHash);

			expect(vi.mocked(applyDiff)).toHaveBeenCalledOnce();
		});
	});

	describe('diff', () => {
		const snapshotToApply = {
			directus: '0.0.0',
			version: 1,
			vendor: 'postgres',
			collections: [
				{
					collection: 'test',
					meta: {
						accountability: 'all',
						collection: 'test',
						group: null,
						hidden: false,
						icon: null,
						item_duplication_fields: null,
						note: null,
						singleton: false,
						translations: {},
					},
					schema: {
						name: 'test',
					},
				},
			],
			fields: [],
			relations: [],
		} satisfies Snapshot;

		it('should throw ForbiddenException for non-admin user', async () => {
			const service = new SchemaService({ knex: db, accountability: { role: 'test', admin: false } });

			await expect(service.diff(snapshotToApply, { currentSnapshot: testSnapshot, force: true })).rejects.toThrowError(
				ForbiddenException
			);
		});

		it('should return diff for admin user', async () => {
			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await expect(service.diff(snapshotToApply, { currentSnapshot: testSnapshot, force: true })).resolves.toEqual({
				collections: [testCollectionDiff],
				fields: [],
				relations: [],
			});
		});

		it('should return null for empty diff', async () => {
			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await expect(service.diff(testSnapshot, { currentSnapshot: testSnapshot, force: true })).resolves.toBeNull();
		});

		it('should compare a version 2 snapshot by folder key', async () => {
			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await expect(
				service.diff(portableWithUploadField('images'), {
					currentSnapshot: snapshotWithUploadField(FOLDER_ID),
					force: true,
				})
			).resolves.toBeNull();
		});

		it('should refuse a version 2 snapshot whose folder key does not exist', async () => {
			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			await expect(
				service.diff(portableWithUploadField('missing'), {
					currentSnapshot: snapshotWithUploadField(FOLDER_ID),
					force: true,
				})
			).rejects.toThrowError(
				'Folder reference "missing" could not be resolved. Referenced by: articles.image.meta.options.folder'
			);
		});
	});

	describe('getHashedSnapshot', () => {
		it('should return snapshot for admin user', async () => {
			const service = new SchemaService({ knex: db, accountability: { role: 'admin', admin: true } });

			expect(service.getHashedSnapshot(testSnapshot)).toEqual(
				expect.objectContaining({
					...testSnapshot,
					hash: expect.any(String),
				})
			);
		});
	});
});
