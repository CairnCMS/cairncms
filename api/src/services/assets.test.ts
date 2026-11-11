import type { Driver } from '@cairncms/storage';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import env from '../env.js';
import {
	ForbiddenException,
	IllegalAssetTransformation,
	RangeNotSatisfiableException,
	ServiceUnavailableException,
} from '../exceptions/index.js';
import { AssetsService } from './assets.js';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const INVALID_UUID = 'not-a-uuid';
const FILE_DISK_NAME = '11111111-2222-4333-8444-555555555555.jpg';

const storageRead = vi.fn<Driver['read']>();
const storageStat = vi.fn<Driver['stat']>(async () => ({ size: 1024, modified: new Date('2026-05-13T00:00:00.000Z') }));
const storageExists = vi.fn<Driver['exists']>(async () => true);
const storageWrite = vi.fn<Driver['write']>(async () => undefined);

vi.mock('../storage/index.js', () => ({
	getStorage: vi.fn(async () => ({
		location: () => ({
			read: storageRead,
			stat: storageStat,
			exists: storageExists,
			write: storageWrite,
		}),
	})),
}));

const checkAccessSpy = vi.fn();

vi.mock('./authorization.js', () => ({
	AuthorizationService: vi.fn().mockImplementation(function () {
		return {
			checkAccess: checkAccessSpy,
		};
	}),
}));

vi.mock('../database/index.js', () => ({
	default: vi.fn(),
}));

const { sharpInstance, sharpFactory, loggerErrorSpy } = vi.hoisted(() => {
	const instance: any = {};
	instance.timeout = vi.fn(() => instance);
	instance.rotate = vi.fn(() => instance);
	instance.resize = vi.fn(() => instance);
	instance.blur = vi.fn(() => instance);
	instance.toFormat = vi.fn(() => instance);
	instance.metadata = vi.fn();
	instance.toBuffer = vi.fn(async () => Buffer.from('transformed'));
	const factory: any = vi.fn(() => instance);
	return { sharpInstance: instance, sharpFactory: factory, loggerErrorSpy: vi.fn() };
});

vi.mock('sharp', () => ({ default: sharpFactory }));

vi.mock('../logger.js', () => ({
	default: {
		error: loggerErrorSpy,
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	},
}));

function makeFileRow(overrides: Partial<Record<string, any>> = {}) {
	return {
		id: VALID_UUID,
		filename_disk: FILE_DISK_NAME,
		filename_download: 'photo.jpg',
		type: 'image/jpeg',
		filesize: 1024,
		width: 800,
		height: 600,
		modified_on: '2026-05-13T00:00:00.000Z',
		storage: 's3',
		...overrides,
	};
}

function primeKnex(tracker: Tracker, fileRow: Record<string, any> | null = makeFileRow()) {
	tracker.on.select('directus_settings').response({});

	if (fileRow) {
		tracker.on.select('directus_files').response([fileRow]);
	} else {
		tracker.on.select('directus_files').response([]);
	}
}

describe('AssetsService.statAsset (GHSA-rv78-qqrq-73m5)', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;
	const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

	const adminAccountability: Accountability = {
		user: 'admin-uuid',
		role: 'role-uuid',
		admin: true,
		app: true,
		ip: '127.0.0.1',
		permissions: [],
	};

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	beforeEach(() => {
		storageRead.mockReset();
		storageStat.mockReset().mockResolvedValue({ size: 1024, modified: new Date('2026-05-13T00:00:00.000Z') });
		storageExists.mockReset().mockResolvedValue(true);
		storageWrite.mockReset().mockResolvedValue(undefined);
		checkAccessSpy.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		tracker.reset();
	});

	describe('no transformation requested', () => {
		it('returns stat from the source file and never opens a read stream', async () => {
			primeKnex(tracker);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			const result = await service.statAsset(VALID_UUID, { transformationParams: {} });

			expect(result.file.id).toBe(VALID_UUID);
			expect(result.stat).toEqual({ size: 1024, modified: new Date('2026-05-13T00:00:00.000Z') });
			expect(storageStat).toHaveBeenCalledWith(FILE_DISK_NAME);
			expect(storageRead).not.toHaveBeenCalled();
		});
	});

	describe('transformation requested, cached variant exists', () => {
		it('returns stat from the cached variant filename, not the source filename', async () => {
			primeKnex(tracker);
			storageExists.mockImplementation(async (name: string) => name !== FILE_DISK_NAME || true);

			storageStat.mockImplementation(async (name: string) => ({
				size: name === FILE_DISK_NAME ? 1024 : 256,
				modified: new Date('2026-05-13T00:00:00.000Z'),
			}));

			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });
			const result = await service.statAsset(VALID_UUID, { transformationParams: { width: 100 } });

			expect(result.stat).not.toBeNull();
			expect(result.stat!.size).toBe(256);
			expect(storageRead).not.toHaveBeenCalled();

			const statCalls = storageStat.mock.calls.map((call) => call[0]);

			expect(
				statCalls.some((name) => name !== FILE_DISK_NAME && name.startsWith('11111111-2222-4333-8444-555555555555__'))
			).toBe(true);
		});
	});

	describe('transformation requested, cached variant does NOT exist', () => {
		it('returns { file, stat: null } without triggering sharp or reading the source', async () => {
			primeKnex(tracker);
			storageExists.mockImplementation(async (name: string) => name === FILE_DISK_NAME);

			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });
			const result = await service.statAsset(VALID_UUID, { transformationParams: { width: 313, format: 'avif' } });

			expect(result.stat).toBeNull();
			expect(storageRead).not.toHaveBeenCalled();
			expect(storageWrite).not.toHaveBeenCalled();
		});

		it('sets file.type to the requested format even when stat is null', async () => {
			primeKnex(tracker);
			storageExists.mockImplementation(async (name: string) => name === FILE_DISK_NAME);

			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });
			const result = await service.statAsset(VALID_UUID, { transformationParams: { format: 'webp' } });

			expect(result.file.type).toBe('image/webp');
			expect(result.stat).toBeNull();
		});
	});

	describe('permission and validation gating', () => {
		it('invokes checkAccess for non-admin callers when the file is not a system public key', async () => {
			primeKnex(tracker);

			const nonAdminAccountability: Accountability = {
				user: 'user-uuid',
				role: 'role-uuid',
				admin: false,
				app: true,
				ip: '127.0.0.1',
				permissions: [],
			};

			const service = new AssetsService({ knex: db, accountability: nonAdminAccountability, schema });
			await service.statAsset(VALID_UUID, { transformationParams: {} });

			expect(checkAccessSpy).toHaveBeenCalledWith('read', 'directus_files', VALID_UUID);
		});

		it('throws ForbiddenException for invalid UUIDs', async () => {
			primeKnex(tracker);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(INVALID_UUID, { transformationParams: {} })).rejects.toBeInstanceOf(
				ForbiddenException
			);

			expect(storageRead).not.toHaveBeenCalled();
		});

		it('throws ForbiddenException when the file row is missing', async () => {
			primeKnex(tracker, null);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(VALID_UUID, { transformationParams: {} })).rejects.toBeInstanceOf(
				ForbiddenException
			);

			expect(storageRead).not.toHaveBeenCalled();
		});

		it('throws ForbiddenException when the source file is missing from storage', async () => {
			primeKnex(tracker);
			storageExists.mockResolvedValue(false);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(VALID_UUID, { transformationParams: {} })).rejects.toBeInstanceOf(
				ForbiddenException
			);

			expect(storageRead).not.toHaveBeenCalled();
		});

		it('throws RangeNotSatisfiableException for a malformed range', async () => {
			primeKnex(tracker);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(VALID_UUID, { transformationParams: {} }, {})).rejects.toBeInstanceOf(
				RangeNotSatisfiableException
			);

			expect(storageRead).not.toHaveBeenCalled();
		});
	});
});

describe('AssetsService.getAsset (regression — must still open a storage read)', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;
	const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

	const adminAccountability: Accountability = {
		user: 'admin-uuid',
		role: 'role-uuid',
		admin: true,
		app: true,
		ip: '127.0.0.1',
		permissions: [],
	};

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	beforeEach(() => {
		storageRead.mockReset().mockResolvedValue(Readable.from([]));

		storageStat.mockReset().mockResolvedValue({ size: 1024, modified: new Date('2026-05-13T00:00:00.000Z') });
		storageExists.mockReset().mockResolvedValue(true);
		storageWrite.mockReset().mockResolvedValue(undefined);
		checkAccessSpy.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		tracker.reset();
	});

	it('opens a storage read on the non-transform path', async () => {
		primeKnex(tracker);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await service.getAsset(VALID_UUID, { transformationParams: {} });

		expect(storageRead).toHaveBeenCalled();
		expect(storageRead.mock.calls[0]![0]).toBe(FILE_DISK_NAME);
	});

	it('opens a storage read on the transform-cached path', async () => {
		primeKnex(tracker);
		storageExists.mockImplementation(async () => true);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await service.getAsset(VALID_UUID, { transformationParams: { width: 100 } });

		expect(storageRead).toHaveBeenCalled();
		const readPaths = storageRead.mock.calls.map((call) => call[0]);
		expect(readPaths.some((name) => name.startsWith('11111111-2222-4333-8444-555555555555__'))).toBe(true);
	});

	it('fetches the source metadata before opening its stream', async () => {
		primeKnex(tracker);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await service.getAsset(VALID_UUID, { transformationParams: {} });

		expect(storageStat).toHaveBeenCalledWith(FILE_DISK_NAME);
		expect(storageStat.mock.invocationCallOrder[0]!).toBeLessThan(storageRead.mock.invocationCallOrder[0]!);
	});

	it('fetches the cached variant metadata before opening its stream', async () => {
		primeKnex(tracker);
		storageExists.mockImplementation(async () => true);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await service.getAsset(VALID_UUID, { transformationParams: { width: 100 } });

		const variant = storageRead.mock.calls[0]![0];
		expect(variant.startsWith('11111111-2222-4333-8444-555555555555__')).toBe(true);
		expect(storageStat).toHaveBeenCalledWith(variant);
		expect(storageStat.mock.invocationCallOrder[0]!).toBeLessThan(storageRead.mock.invocationCallOrder[0]!);
	});

	it('opens no stream when the metadata lookup fails', async () => {
		primeKnex(tracker);
		const statError = new Error('metadata unavailable');
		storageStat.mockRejectedValueOnce(statError);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await expect(service.getAsset(VALID_UUID, { transformationParams: {} })).rejects.toBe(statError);

		expect(storageRead).not.toHaveBeenCalled();
	});

	it('rejects with the read error when the object disappears after its metadata lookup', async () => {
		primeKnex(tracker);
		const readError = new Error('object not found');
		storageRead.mockRejectedValueOnce(readError);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await expect(service.getAsset(VALID_UUID, { transformationParams: {} })).rejects.toBe(readError);

		expect(storageStat).toHaveBeenCalledTimes(1);
	});

	it('returns the metadata observed before the stream was opened', async () => {
		primeKnex(tracker);
		const observed = { size: 2048, modified: new Date('2026-11-10T00:00:00.000Z') };
		storageStat.mockResolvedValueOnce(observed);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		const result = await service.getAsset(VALID_UUID, { transformationParams: {} });

		expect(result.stat).toBe(observed);
	});
});

describe('AssetsService.getAsset uncached-transform pipeline (GHSA-j8xj-7jff-46mx)', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;
	const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

	const adminAccountability: Accountability = {
		user: 'admin-uuid',
		role: 'role-uuid',
		admin: true,
		app: true,
		ip: '127.0.0.1',
		permissions: [],
	};

	function sourceStream(content = 'source'): Readable {
		return Readable.from([Buffer.from(content)], { objectMode: false });
	}

	function failingStream(error: Error): Readable {
		return new Readable({
			read() {
				this.destroy(error);
			},
		});
	}

	function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((done) => (resolve = done));
		return { promise, resolve };
	}

	function requestTransform(service: AssetsService) {
		return service.getAsset(VALID_UUID, { transformationParams: { width: 100 } });
	}

	function sourceHeader(width: number, height: number) {
		return { width, height, autoOrient: { width, height } };
	}

	const maxDimension = () => Number(env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION']);

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	beforeEach(() => {
		storageRead.mockReset().mockImplementation(async () => sourceStream());
		storageStat.mockReset().mockResolvedValue({ size: 1024, modified: new Date('2026-05-13T00:00:00.000Z') });
		storageWrite.mockReset().mockResolvedValue(undefined);
		checkAccessSpy.mockReset().mockResolvedValue(undefined);
		storageExists.mockReset().mockImplementation(async (name: string) => name === FILE_DISK_NAME);
		sharpFactory.mockClear();
		sharpInstance.timeout.mockClear();
		sharpInstance.rotate.mockClear();
		sharpInstance.resize.mockClear();
		sharpInstance.toFormat.mockClear();
		sharpInstance.blur.mockClear();
		sharpInstance.metadata.mockReset().mockResolvedValue(sourceHeader(800, 600));
		sharpInstance.toBuffer.mockReset().mockResolvedValue(Buffer.from('transformed'));
		loggerErrorSpy.mockReset();
		primeKnex(tracker);
	});

	afterEach(() => {
		tracker.reset();
	});

	it('does not open the source read stream when a transform method throws on apply', async () => {
		sharpInstance.resize.mockImplementationOnce(() => {
			throw new Error('sharp: bad resize args');
		});

		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await expect(requestTransform(service)).rejects.toThrow(/bad resize args/);

		expect(storageRead).not.toHaveBeenCalled();
	});

	it('transforms the whole source and writes the result (regression)', async () => {
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await requestTransform(service);

		expect(storageRead.mock.calls[0]![0]).toBe(FILE_DISK_NAME);

		expect(sharpFactory).toHaveBeenLastCalledWith(
			Buffer.from('source'),
			expect.objectContaining({ sequentialRead: true })
		);

		expect(sharpInstance.toBuffer).toHaveBeenCalledTimes(1);
		expect(storageWrite).toHaveBeenCalledTimes(1);
		expect(await buffer(storageWrite.mock.calls[0]![1])).toEqual(Buffer.from('transformed'));
	});

	it('fetches the generated variant metadata before opening its stream', async () => {
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await requestTransform(service);

		const variant = storageWrite.mock.calls[0]![0];
		const variantRead = storageRead.mock.calls.findIndex((call) => call[0] === variant);
		expect(variantRead).toBeGreaterThan(0);
		expect(storageStat).toHaveBeenCalledWith(variant);
		expect(storageStat.mock.invocationCallOrder[0]!).toBeLessThan(storageRead.mock.invocationCallOrder[variantRead]!);
	});

	it('logs a source stream error, rejects with it, and writes nothing', async () => {
		const readErr = new Error('s3 stream dropped');
		storageRead.mockReset().mockResolvedValueOnce(failingStream(readErr));
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await expect(requestTransform(service)).rejects.toThrow(/s3 stream dropped/);

		expect(loggerErrorSpy).toHaveBeenCalledWith(readErr, expect.stringContaining(VALID_UUID));
		expect(sharpInstance.toBuffer).not.toHaveBeenCalled();
		expect(storageWrite).not.toHaveBeenCalled();
	});

	describe('size limit', () => {
		it('rejects a source whose header exceeds the limit when the stored row understates it', async () => {
			tracker.reset();
			primeKnex(tracker, makeFileRow({ width: 10, height: 10 }));
			sharpInstance.metadata.mockResolvedValue(sourceHeader(maxDimension() + 1, 10));
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(requestTransform(service)).rejects.toBeInstanceOf(IllegalAssetTransformation);

			expect(sharpInstance.toBuffer).not.toHaveBeenCalled();
			expect(storageWrite).not.toHaveBeenCalled();
		});

		it('computes the output from the header rather than the stored row', async () => {
			tracker.reset();
			primeKnex(tracker, makeFileRow({ width: 10, height: 10 }));
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(
				service.getAsset(VALID_UUID, { transformationParams: { height: maxDimension() } })
			).rejects.toBeInstanceOf(IllegalAssetTransformation);

			expect(sharpInstance.toBuffer).not.toHaveBeenCalled();
		});

		it('rejects a resize whose output would exceed the limit', async () => {
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(
				service.getAsset(VALID_UUID, { transformationParams: { width: maxDimension() + 1 } })
			).rejects.toBeInstanceOf(IllegalAssetTransformation);

			expect(sharpInstance.toBuffer).not.toHaveBeenCalled();
			expect(storageWrite).not.toHaveBeenCalled();
		});

		it('transforms a resize at exactly the limit', async () => {
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await service.getAsset(VALID_UUID, { transformationParams: { width: maxDimension() } });

			expect(sharpInstance.toBuffer).toHaveBeenCalledTimes(1);
			expect(storageWrite).toHaveBeenCalledTimes(1);
		});

		it('transforms an inside resize at exactly the limit when the scale is inexact', async () => {
			const configured = env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'];
			env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'] = 1000;
			sharpInstance.metadata.mockResolvedValue(sourceHeader(15, 14));

			try {
				tracker.reset();
				primeKnex(tracker, makeFileRow({ width: 15, height: 14 }));
				const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

				await service.getAsset(VALID_UUID, { transformationParams: { width: 1000, height: 1000, fit: 'inside' } });

				expect(sharpInstance.toBuffer).toHaveBeenCalledTimes(1);
			} finally {
				env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'] = configured;
			}
		});

		it('reads the header without the pixel limit and transforms with it', async () => {
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await requestTransform(service);

			expect(sharpFactory).toHaveBeenCalledWith(
				Buffer.from('source'),
				expect.objectContaining({ limitInputPixels: false })
			);

			expect(sharpFactory).toHaveBeenLastCalledWith(
				Buffer.from('source'),
				expect.objectContaining({ limitInputPixels: Math.pow(maxDimension(), 2) })
			);
		});

		it('checks only the source for advanced transformations', async () => {
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await service.getAsset(VALID_UUID, {
				transformationParams: { width: maxDimension() + 1, transforms: [['blur', 1]] },
			});

			expect(sharpInstance.toBuffer).toHaveBeenCalledTimes(1);
		});

		it('serves a cached derivative without reading the header', async () => {
			storageExists.mockImplementation(async () => true);
			sharpInstance.metadata.mockResolvedValue(sourceHeader(maxDimension() + 1, 10));
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(requestTransform(service)).resolves.toBeDefined();

			expect(sharpFactory).not.toHaveBeenCalled();
		});
	});

	describe('admission', () => {
		let configuredLimit: unknown;

		beforeEach(() => {
			configuredLimit = env['ASSETS_TRANSFORM_MAX_CONCURRENT'];
			env['ASSETS_TRANSFORM_MAX_CONCURRENT'] = 2;
		});

		afterEach(() => {
			env['ASSETS_TRANSFORM_MAX_CONCURRENT'] = configuredLimit;
		});

		it('admits no more transforms than the setting until one finishes', async () => {
			const first = deferred<Buffer>();
			const second = deferred<Buffer>();
			sharpInstance.toBuffer.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			const running = [requestTransform(service), requestTransform(service)];
			await vi.waitFor(() => expect(sharpInstance.toBuffer).toHaveBeenCalledTimes(2));

			await expect(requestTransform(service)).rejects.toBeInstanceOf(ServiceUnavailableException);

			first.resolve(Buffer.from('a'));
			await running[0];

			await expect(requestTransform(service)).resolves.toBeDefined();

			second.resolve(Buffer.from('b'));
			await running[1];
		});

		it.each<[string, () => void, RegExp]>([
			[
				'a transform argument error',
				() =>
					sharpInstance.resize.mockImplementationOnce(() => {
						throw new Error('bad resize args');
					}),
				/bad resize args/,
			],
			['a source read failure', () => storageRead.mockRejectedValueOnce(new Error('source missing')), /source missing/],
			[
				'an oversized source header',
				() => sharpInstance.metadata.mockResolvedValueOnce(sourceHeader(maxDimension() + 1, 10)),
				/too large/,
			],
			[
				'a source stream error',
				() => storageRead.mockResolvedValueOnce(failingStream(new Error('stream dropped'))),
				/stream dropped/,
			],
			[
				'a transform failure or timeout',
				() => sharpInstance.toBuffer.mockRejectedValueOnce(new Error('sharp: timeout')),
				/sharp: timeout/,
			],
			['a storage write failure', () => storageWrite.mockRejectedValueOnce(new Error('write failed')), /write failed/],
		])('releases the slot after %s', async (_label, fail, message) => {
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			for (let attempt = 0; attempt < 3; attempt++) {
				fail();
				await expect(requestTransform(service)).rejects.toThrow(message);
			}

			await expect(requestTransform(service)).resolves.toBeDefined();
		});
	});
});
