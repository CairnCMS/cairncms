import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import { Readable } from 'node:stream';
import type { MockedFunction, SpyInstance } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import env from '../env.js';
import {
	ContentTooLargeException,
	ForbiddenException,
	InvalidPayloadException,
	ServiceUnavailableException,
} from '../exceptions/index.js';
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
const storageRead = vi.fn();

vi.mock('../storage/index.js', () => ({
	getStorage: vi.fn(async () => ({
		location: () => ({
			write: storageWrite,
			stat: storageStat,
			list: storageList,
			delete: storageDelete,
			read: storageRead,
		}),
	})),
}));

vi.mock('../emitter.js', () => ({
	default: {
		emitAction: vi.fn(),
	},
}));

const { mockCheckAccess, mockValidatePayload } = vi.hoisted(() => ({
	mockCheckAccess: vi.fn(),
	mockValidatePayload: vi.fn(),
}));

vi.mock('./authorization.js', () => ({
	AuthorizationService: vi.fn(() => ({
		checkAccess: mockCheckAccess,
		validatePayload: mockValidatePayload,
	})),
}));

const { mockAxiosGet } = vi.hoisted(() => ({ mockAxiosGet: vi.fn() }));

vi.mock('../request/index.js', () => ({
	getAxios: vi.fn(async () => ({ get: mockAxiosGet })),
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

			it('writes a replacement to a fresh primary-key-prefixed path, ignoring attacker-supplied filename_disk', async () => {
				const primaryKey = 'aaaaaaaa-1111-2222-3333-cccccccccccc';

				tracker.on
					.select(/select "folder", "filename_download"/)
					.response({ folder: null, filename_download: 'legit.bin', storage: 'local' });

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
				const diskPath = (storageWrite.mock.calls[0] as unknown[])[0] as string;
				expect(diskPath).toMatch(new RegExp(`^${primaryKey}-[A-Za-z0-9_-]+\\.bin$`));
				expect(diskPath).not.toContain('victim-deadbeef');

				const finalUpdateCall = superUpdateOne.mock.calls.at(-1)!;
				const finalPayload = finalUpdateCall[1] as Record<string, unknown>;
				expect(finalPayload['filename_disk']).toBe(diskPath);
				expect(finalPayload).not.toHaveProperty('uploaded_by');
			});
		});

		describe('uploadOne — auth gate, size limit, and cleanup', () => {
			const primaryKey = 'aaaaaaaa-1111-2222-3333-cccccccccccc';

			const data = {
				storage: 'local',
				type: 'application/octet-stream',
				folder: null,
				filename_download: 'upload.bin',
			};

			beforeEach(() => {
				storageWrite.mockReset().mockResolvedValue(undefined);
				storageStat.mockReset().mockResolvedValue({ size: 42 });

				storageList.mockReset().mockReturnValue({
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						return;
					},
				});

				storageDelete.mockReset().mockResolvedValue(undefined);
				mockCheckAccess.mockReset().mockResolvedValue(undefined);
				mockValidatePayload.mockReset().mockImplementation((_action, _collection, payload) => payload);
				vi.spyOn(ItemsService.prototype, 'updateOne').mockResolvedValue(1 as never);
			});

			afterEach(() => {
				vi.restoreAllMocks();
			});

			function uploadService() {
				return new FilesService({ knex: db, schema: { collections: {}, relations: [] } });
			}

			function authedService() {
				return new FilesService({
					knex: db,
					schema: { collections: {}, relations: [] },
					accountability: { role: 'role', user: 'user', admin: false, app: true } as never,
				});
			}

			function mockExisting() {
				tracker.on
					.select(/select "folder", "filename_download"/)
					.response({ folder: null, filename_download: 'old.bin', storage: 'local' });
			}

			it('rejects a replace without update access before writing anything', async () => {
				mockExisting();
				mockCheckAccess.mockRejectedValue(new ForbiddenException());

				await expect(
					authedService().uploadOne(Readable.from(['x']), { ...data }, primaryKey, { emitEvents: false })
				).rejects.toBeInstanceOf(ForbiddenException);

				expect(storageWrite).not.toHaveBeenCalled();
			});

			it('rejects a disallowed field update before writing anything', async () => {
				mockExisting();

				mockValidatePayload.mockImplementation(() => {
					throw new ForbiddenException();
				});

				await expect(
					authedService().uploadOne(Readable.from(['x']), { ...data }, primaryKey, { emitEvents: false })
				).rejects.toBeInstanceOf(ForbiddenException);

				expect(storageWrite).not.toHaveBeenCalled();
			});

			it('rejects a truncated replacement and cleans only the fresh object', async () => {
				mockExisting();
				const stream = Readable.from(['too-big']);
				(stream as Readable & { truncated?: boolean }).truncated = true;

				await expect(
					uploadService().uploadOne(stream, { ...data }, primaryKey, { emitEvents: false })
				).rejects.toBeInstanceOf(ContentTooLargeException);

				expect(storageWrite).toHaveBeenCalledOnce();
				const freshKey = (storageWrite.mock.calls[0] as unknown[])[0];
				expect(storageDelete).toHaveBeenCalledWith(freshKey);
				expect(ItemsService.prototype.updateOne).not.toHaveBeenCalled();
			});

			it('cleans the new row and object when a create write fails', async () => {
				const newPk = 'bbbbbbbb-1111-2222-3333-cccccccccccc';
				vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue(newPk as never);
				const deleteSpy = vi.spyOn(ItemsService.prototype, 'deleteOne').mockResolvedValue(newPk as never);
				storageWrite.mockRejectedValueOnce(new Error('disk full'));

				await expect(
					uploadService().uploadOne(Readable.from(['x']), { ...data }, undefined, { emitEvents: false })
				).rejects.toBeInstanceOf(ServiceUnavailableException);

				expect(deleteSpy).toHaveBeenCalledWith(newPk, { emitEvents: false });
				expect(storageDelete).toHaveBeenCalled();
			});

			it('removes the new row even when object cleanup itself fails', async () => {
				const newPk = 'cccccccc-1111-2222-3333-cccccccccccc';
				vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue(newPk as never);
				const deleteSpy = vi.spyOn(ItemsService.prototype, 'deleteOne').mockResolvedValue(newPk as never);
				storageWrite.mockRejectedValueOnce(new Error('disk full'));
				storageDelete.mockRejectedValue(new Error('location gone'));

				await expect(
					uploadService().uploadOne(Readable.from(['x']), { ...data }, undefined, { emitEvents: false })
				).rejects.toBeInstanceOf(ServiceUnavailableException);

				expect(deleteSpy).toHaveBeenCalledWith(newPk, { emitEvents: false });
			});

			it('preserves the existing row and old object when a replace write fails', async () => {
				mockExisting();
				const deleteSpy = vi.spyOn(ItemsService.prototype, 'deleteOne');
				storageWrite.mockRejectedValueOnce(new Error('disk full'));

				await expect(
					uploadService().uploadOne(Readable.from(['x']), { ...data }, primaryKey, { emitEvents: false })
				).rejects.toBeInstanceOf(ServiceUnavailableException);

				expect(deleteSpy).not.toHaveBeenCalled();
				const freshKey = (storageWrite.mock.calls[0] as unknown[])[0];
				expect(storageDelete).toHaveBeenCalledWith(freshKey);
			});

			it('deletes old objects but never the live one on a successful replace', async () => {
				mockExisting();

				storageList.mockReturnValue({
					async *[Symbol.asyncIterator]() {
						yield `${primaryKey}.bin`;
						const fresh = (storageWrite.mock.calls[0] as unknown[] | undefined)?.[0];
						if (fresh) yield fresh as string;
					},
				});

				await uploadService().uploadOne(Readable.from(['x']), { ...data }, primaryKey, { emitEvents: false });

				const freshKey = (storageWrite.mock.calls[0] as unknown[])[0];
				expect(storageDelete).toHaveBeenCalledWith(`${primaryKey}.bin`);
				expect(storageDelete).not.toHaveBeenCalledWith(freshKey);
			});

			function mockExistingWithMetadata() {
				tracker.on.select(/select "folder", "filename_download"/).response({
					folder: null,
					filename_download: 'old.png',
					storage: 'local',
					title: 'Operator Title',
					description: 'Operator Desc',
					tags: ['a', 'b'],
					metadata: { ifd0: { Make: 'CairnCam' } },
				});

				vi.spyOn(FilesService.prototype as any, 'getMetadata').mockResolvedValue({});
			}

			it('keeps operator-set title/description/tags on an image replace when not re-supplied', async () => {
				mockExistingWithMetadata();
				const updateSpy = vi.mocked(ItemsService.prototype.updateOne);

				await uploadService().uploadOne(
					Readable.from(['img']),
					{ storage: 'local', type: 'image/png', filename_download: 'new.png', folder: null },
					primaryKey,
					{ emitEvents: false }
				);

				const finalPayload = updateSpy.mock.calls.at(-1)![1] as Record<string, unknown>;
				expect(finalPayload['title']).toBe('Operator Title');
				expect(finalPayload['description']).toBe('Operator Desc');
				expect(finalPayload['tags']).toEqual(['a', 'b']);
				expect(finalPayload['metadata']).toEqual({ ifd0: { Make: 'CairnCam' } });
			});

			it('lets a caller-supplied field override the preserved one on an image replace', async () => {
				mockExistingWithMetadata();
				const updateSpy = vi.mocked(ItemsService.prototype.updateOne);

				await uploadService().uploadOne(
					Readable.from(['img']),
					{ storage: 'local', type: 'image/png', filename_download: 'new.png', folder: null, title: 'New Title' },
					primaryKey,
					{ emitEvents: false }
				);

				const finalPayload = updateSpy.mock.calls.at(-1)![1] as Record<string, unknown>;
				expect(finalPayload['title']).toBe('New Title');
				expect(finalPayload['description']).toBe('Operator Desc');
			});
		});

		describe('importOne — MIME allow-list and size cap on URL imports', () => {
			function axiosResponse(contentType: string, byteCount: number) {
				let sent = 0;

				const data = new Readable({
					read() {
						if (sent >= byteCount) return this.push(null);
						const n = Math.min(4, byteCount - sent);
						sent += n;
						this.push(Buffer.alloc(n, 0x61));
					},
				});

				return {
					data,
					headers: { 'content-type': contentType },
					request: { res: { responseUrl: 'https://example.com/import/photo.png' } },
				};
			}

			function drainingWrite() {
				storageWrite.mockImplementationOnce(async (_path: string, stream: Readable) => {
					for await (const chunk of stream) {
						void chunk;
					}
				});
			}

			function service() {
				return new FilesService({ knex: db, schema: { collections: {}, relations: [] } });
			}

			beforeEach(() => {
				storageWrite.mockReset().mockResolvedValue(undefined);
				storageStat.mockReset().mockResolvedValue({ size: 42 });
				storageDelete.mockReset().mockResolvedValue(undefined);
				mockAxiosGet.mockReset();
				tracker.on.select(/storage_default_folder/).response({ storage_default_folder: null });
			});

			afterEach(() => {
				env['FILES_MIME_TYPE_ALLOW_LIST'] = '*/*';
				delete env['FILES_MAX_UPLOAD_SIZE'];
				vi.restoreAllMocks();
			});

			it('rejects a URL import whose content type is not allowed and aborts the fetched stream', async () => {
				env['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*';
				const response = axiosResponse('application/pdf', 8);
				mockAxiosGet.mockResolvedValue(response);
				const uploadSpy = vi.spyOn(FilesService.prototype, 'uploadOne');

				await expect(service().importOne('https://example.com/x.pdf', {})).rejects.toBeInstanceOf(
					InvalidPayloadException
				);

				expect(uploadSpy).not.toHaveBeenCalled();
				expect(response.data.destroyed).toBe(true);
			});

			it('imports a URL whose content type is allowed and stores the normalized type', async () => {
				env['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*';
				mockAxiosGet.mockResolvedValue(axiosResponse('image/png; charset=binary', 8));
				const uploadSpy = vi.spyOn(FilesService.prototype, 'uploadOne').mockResolvedValue('new-key' as never);

				await service().importOne('https://example.com/x.png', {});

				expect(uploadSpy).toHaveBeenCalledOnce();
				expect((uploadSpy.mock.calls[0]![1] as Record<string, unknown>).type).toBe('image/png');
			});

			it('stores the server-resolved type, ignoring a caller-supplied type override', async () => {
				env['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*';
				mockAxiosGet.mockResolvedValue(axiosResponse('image/png', 8));
				const uploadSpy = vi.spyOn(FilesService.prototype, 'uploadOne').mockResolvedValue('new-key' as never);

				await service().importOne('https://example.com/x.png', { type: 'application/x-evil' } as never);

				expect((uploadSpy.mock.calls[0]![1] as Record<string, unknown>).type).toBe('image/png');
			});

			it('rejects an over-limit URL import and cleans up the new row', async () => {
				env['FILES_MAX_UPLOAD_SIZE'] = '10b';
				mockAxiosGet.mockResolvedValue(axiosResponse('image/png', 100));
				vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue('new-key' as never);
				const deleteSpy = vi.spyOn(ItemsService.prototype, 'deleteOne').mockResolvedValue('new-key' as never);
				drainingWrite();

				await expect(service().importOne('https://example.com/big.png', {})).rejects.toBeInstanceOf(
					ContentTooLargeException
				);

				expect(deleteSpy).toHaveBeenCalled();
			});

			it('imports a URL within the size cap', async () => {
				env['FILES_MAX_UPLOAD_SIZE'] = '1mb';
				mockAxiosGet.mockResolvedValue(axiosResponse('application/octet-stream', 8));
				vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue('new-key' as never);
				vi.spyOn(ItemsService.prototype, 'updateOne').mockResolvedValue('new-key' as never);
				drainingWrite();

				const key = await service().importOne('https://example.com/small.png', {});
				expect(key).toBe('new-key');
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
