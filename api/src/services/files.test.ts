import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import { Readable } from 'node:stream';
import type { MockedFunction, SpyInstance } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidPayloadException } from '../exceptions/index.js';
import { FilesService, ItemsService } from './index.js';

const ATTACKER_FILENAME_DISK = '../victim-deadbeef.bin';
const ATTACKER_UPLOADED_BY = '00000000-dead-dead-dead-000000000000';

const storageWrite = vi.fn(async () => undefined);
const storageStat = vi.fn(async () => ({ size: 42 }));

const storageList = vi.fn(() => ({
	async *[Symbol.asyncIterator]() {
		// no entries
	},
}));

const storageDelete = vi.fn(async () => undefined);

vi.mock('../storage/index.js', () => ({
	getStorage: vi.fn(async () => ({
		location: () => ({
			write: storageWrite,
			stat: storageStat,
			list: storageList,
			delete: storageDelete,
		}),
	})),
}));

vi.mock('../emitter.js', () => ({
	default: {
		emitAction: vi.fn(),
	},
}));

describe('Integration Tests', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
		vi.clearAllMocks();
	});

	describe('Services / Files', () => {
		describe('createOne', () => {
			let service: FilesService;
			let superCreateOne: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superCreateOne = vi.spyOn(ItemsService.prototype, 'createOne').mockReturnValue(Promise.resolve(1));
			});

			it('throws InvalidPayloadException when "type" is not provided', async () => {
				try {
					await service.createOne({
						title: 'Test File',
						storage: 'local',
						filename_download: 'test_file',
					});
				} catch (err: any) {
					expect(err).toBeInstanceOf(InvalidPayloadException);
					expect(err.message).toBe('"type" is required');
				}

				expect(superCreateOne).not.toHaveBeenCalled();
			});

			it('creates a file entry when "type" is provided', async () => {
				await service.createOne({
					title: 'Test File',
					storage: 'local',
					filename_download: 'test_file',
					type: 'application/octet-stream',
				});

				expect(superCreateOne).toHaveBeenCalled();
			});

			it('strips user-supplied filename_disk and uploaded_by before reaching super', async () => {
				await service.createOne({
					title: 'Test File',
					storage: 'local',
					filename_download: 'test_file',
					type: 'application/octet-stream',
					filename_disk: ATTACKER_FILENAME_DISK,
					uploaded_by: ATTACKER_UPLOADED_BY,
				} as any);

				expect(superCreateOne).toHaveBeenCalledOnce();
				const [payload] = superCreateOne.mock.calls[0]!;
				expect(payload).not.toHaveProperty('filename_disk');
				expect(payload).not.toHaveProperty('uploaded_by');
				expect(payload.title).toBe('Test File');
				expect(payload.type).toBe('application/octet-stream');
			});
		});

		describe('createMany', () => {
			let service: FilesService;
			let superCreateMany: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superCreateMany = vi.spyOn(ItemsService.prototype, 'createMany').mockReturnValue(Promise.resolve([1, 2]));
			});

			it('strips user-supplied filename_disk and uploaded_by from every item before reaching super', async () => {
				await service.createMany([
					{
						title: 'File A',
						type: 'application/octet-stream',
						filename_disk: ATTACKER_FILENAME_DISK,
						uploaded_by: ATTACKER_UPLOADED_BY,
					} as any,
					{
						title: 'File B',
						type: 'application/octet-stream',
						filename_disk: ATTACKER_FILENAME_DISK,
						uploaded_by: ATTACKER_UPLOADED_BY,
					} as any,
				]);

				expect(superCreateMany).toHaveBeenCalledOnce();
				const [payloads] = superCreateMany.mock.calls[0]!;
				expect(payloads).toHaveLength(2);

				for (const payload of payloads) {
					expect(payload).not.toHaveProperty('filename_disk');
					expect(payload).not.toHaveProperty('uploaded_by');
				}

				expect(payloads[0].title).toBe('File A');
				expect(payloads[1].title).toBe('File B');
			});
		});

		describe('updateOne', () => {
			let service: FilesService;
			let superUpdateOne: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superUpdateOne = vi.spyOn(ItemsService.prototype, 'updateOne').mockReturnValue(Promise.resolve(1));
			});

			it('strips user-supplied filename_disk and uploaded_by before reaching super', async () => {
				await service.updateOne(1, {
					title: 'Renamed',
					filename_disk: ATTACKER_FILENAME_DISK,
					uploaded_by: ATTACKER_UPLOADED_BY,
				} as any);

				expect(superUpdateOne).toHaveBeenCalledOnce();
				const [key, payload] = superUpdateOne.mock.calls[0]!;
				expect(key).toBe(1);
				expect(payload).not.toHaveProperty('filename_disk');
				expect(payload).not.toHaveProperty('uploaded_by');
				expect(payload.title).toBe('Renamed');
			});
		});

		describe('updateMany', () => {
			let service: FilesService;
			let superUpdateMany: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superUpdateMany = vi.spyOn(ItemsService.prototype, 'updateMany').mockReturnValue(Promise.resolve([1, 2]));
			});

			it('strips user-supplied filename_disk and uploaded_by before reaching super', async () => {
				await service.updateMany([1, 2], {
					title: 'Renamed',
					filename_disk: ATTACKER_FILENAME_DISK,
					uploaded_by: ATTACKER_UPLOADED_BY,
				} as any);

				expect(superUpdateMany).toHaveBeenCalledOnce();
				const [keys, payload] = superUpdateMany.mock.calls[0]!;
				expect(keys).toEqual([1, 2]);
				expect(payload).not.toHaveProperty('filename_disk');
				expect(payload).not.toHaveProperty('uploaded_by');
				expect(payload.title).toBe('Renamed');
			});
		});

		describe('updateBatch', () => {
			let service: FilesService;
			let superUpdateBatch: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superUpdateBatch = vi.spyOn(ItemsService.prototype, 'updateBatch').mockReturnValue(Promise.resolve([1, 2]));
			});

			it('strips user-supplied filename_disk and uploaded_by from every item before reaching super', async () => {
				await service.updateBatch([
					{
						id: 1,
						title: 'File A renamed',
						filename_disk: ATTACKER_FILENAME_DISK,
						uploaded_by: ATTACKER_UPLOADED_BY,
					} as any,
					{
						id: 2,
						title: 'File B renamed',
						filename_disk: ATTACKER_FILENAME_DISK,
						uploaded_by: ATTACKER_UPLOADED_BY,
					} as any,
				]);

				expect(superUpdateBatch).toHaveBeenCalledOnce();
				const [payloads] = superUpdateBatch.mock.calls[0]!;
				expect(payloads).toHaveLength(2);

				for (const payload of payloads) {
					expect(payload).not.toHaveProperty('filename_disk');
					expect(payload).not.toHaveProperty('uploaded_by');
				}

				expect(payloads[0].id).toBe(1);
				expect(payloads[0].title).toBe('File A renamed');
				expect(payloads[1].id).toBe(2);
				expect(payloads[1].title).toBe('File B renamed');
			});
		});

		describe('uploadOne — regression guard for strip overrides', () => {
			let service: FilesService;
			let superUpdateOne: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superUpdateOne = vi.spyOn(ItemsService.prototype, 'updateOne').mockReturnValue(Promise.resolve(1));

				storageWrite.mockClear();
				storageStat.mockClear();
				storageList.mockClear();
				storageDelete.mockClear();
			});

			it('writes uploaded bytes to the primary-key-derived path, ignoring attacker-supplied filename_disk', async () => {
				const primaryKey = 'aaaaaaaa-1111-2222-3333-cccccccccccc';

				tracker.on
					.select(/select "folder", "filename_download" from "directus_files"/)
					.response({ folder: null, filename_download: 'legit.bin' });

				tracker.on
					.select(/select "storage_default_folder" from "directus_settings"/)
					.response({ storage_default_folder: null });

				const stream = Readable.from(['payload-bytes']);

				await service.uploadOne(
					stream,
					{
						storage: 'local',
						type: 'application/octet-stream',
						filename_download: 'legit.bin',
						filename_disk: ATTACKER_FILENAME_DISK,
						uploaded_by: ATTACKER_UPLOADED_BY,
					},
					primaryKey,
					{ emitEvents: false }
				);

				expect(storageWrite).toHaveBeenCalledOnce();
				const diskPath = (storageWrite.mock.calls[0] as unknown[])[0];
				expect(diskPath).toBe(`${primaryKey}.bin`);
				expect(diskPath).not.toContain('victim-deadbeef');

				const finalUpdateCall = superUpdateOne.mock.calls.at(-1)!;
				const finalPayload = finalUpdateCall[1] as Record<string, unknown>;
				expect(finalPayload['filename_disk']).toBe(`${primaryKey}.bin`);
			});
		});

		describe('updateByQuery', () => {
			let service: FilesService;
			let superUpdateByQuery: SpyInstance;

			beforeEach(() => {
				service = new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				superUpdateByQuery = vi.spyOn(ItemsService.prototype, 'updateByQuery').mockReturnValue(Promise.resolve([1]));
			});

			it('strips user-supplied filename_disk and uploaded_by before reaching super', async () => {
				const query = { filter: { type: { _eq: 'image/png' } } };

				await service.updateByQuery(query, {
					title: 'Bulk renamed',
					filename_disk: ATTACKER_FILENAME_DISK,
					uploaded_by: ATTACKER_UPLOADED_BY,
				} as any);

				expect(superUpdateByQuery).toHaveBeenCalledOnce();
				const [passedQuery, payload] = superUpdateByQuery.mock.calls[0]!;
				expect(passedQuery).toEqual(query);
				expect(payload).not.toHaveProperty('filename_disk');
				expect(payload).not.toHaveProperty('uploaded_by');
				expect(payload.title).toBe('Bulk renamed');
			});
		});
	});
});
