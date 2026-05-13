import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, RangeNotSatisfiableException } from '../exceptions/index.js';
import { AssetsService } from './assets.js';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const INVALID_UUID = 'not-a-uuid';
const FILE_DISK_NAME = '11111111-2222-4333-8444-555555555555.jpg';

const storageRead = vi.fn<[string, any?], Promise<any>>();
const storageStat = vi.fn<[string], Promise<{ size: number }>>(async () => ({ size: 1024 }));
const storageExists = vi.fn<[string], Promise<boolean>>(async () => true);
const storageWrite = vi.fn<[string, any, any?], Promise<void>>(async () => undefined);

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
	AuthorizationService: vi.fn().mockImplementation(() => ({
		checkAccess: checkAccessSpy,
	})),
}));

vi.mock('../database/index.js', () => ({
	default: vi.fn(),
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
		storageStat.mockReset().mockResolvedValue({ size: 1024 });
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

			const result = await service.statAsset(VALID_UUID, {});

			expect(result.file.id).toBe(VALID_UUID);
			expect(result.stat).toEqual({ size: 1024 });
			expect(storageStat).toHaveBeenCalledWith(FILE_DISK_NAME);
			expect(storageRead).not.toHaveBeenCalled();
		});
	});

	describe('transformation requested, cached variant exists', () => {
		it('returns stat from the cached variant filename, not the source filename', async () => {
			primeKnex(tracker);
			storageExists.mockImplementation(async (name: string) => name !== FILE_DISK_NAME || true);
			storageStat.mockImplementation(async (name: string) => ({ size: name === FILE_DISK_NAME ? 1024 : 256 }));

			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });
			const result = await service.statAsset(VALID_UUID, { width: 100 });

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
			const result = await service.statAsset(VALID_UUID, { width: 313, format: 'avif' });

			expect(result.stat).toBeNull();
			expect(storageRead).not.toHaveBeenCalled();
			expect(storageWrite).not.toHaveBeenCalled();
		});

		it('sets file.type to the requested format even when stat is null', async () => {
			primeKnex(tracker);
			storageExists.mockImplementation(async (name: string) => name === FILE_DISK_NAME);

			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });
			const result = await service.statAsset(VALID_UUID, { format: 'webp' });

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
			await service.statAsset(VALID_UUID, {});

			expect(checkAccessSpy).toHaveBeenCalledWith('read', 'directus_files', VALID_UUID);
		});

		it('throws ForbiddenException for invalid UUIDs', async () => {
			primeKnex(tracker);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(INVALID_UUID, {})).rejects.toBeInstanceOf(ForbiddenException);
			expect(storageRead).not.toHaveBeenCalled();
		});

		it('throws ForbiddenException when the file row is missing', async () => {
			primeKnex(tracker, null);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(VALID_UUID, {})).rejects.toBeInstanceOf(ForbiddenException);
			expect(storageRead).not.toHaveBeenCalled();
		});

		it('throws ForbiddenException when the source file is missing from storage', async () => {
			primeKnex(tracker);
			storageExists.mockResolvedValue(false);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(VALID_UUID, {})).rejects.toBeInstanceOf(ForbiddenException);
			expect(storageRead).not.toHaveBeenCalled();
		});

		it('throws RangeNotSatisfiableException for a malformed range', async () => {
			primeKnex(tracker);
			const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

			await expect(service.statAsset(VALID_UUID, {}, {})).rejects.toBeInstanceOf(RangeNotSatisfiableException);
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
		storageRead.mockReset().mockResolvedValue({
			on: vi.fn(),
			pipe: vi.fn(),
			destroy: vi.fn(),
		});

		storageStat.mockReset().mockResolvedValue({ size: 1024 });
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

		await service.getAsset(VALID_UUID, {});

		expect(storageRead).toHaveBeenCalled();
		expect(storageRead.mock.calls[0]![0]).toBe(FILE_DISK_NAME);
	});

	it('opens a storage read on the transform-cached path', async () => {
		primeKnex(tracker);
		storageExists.mockImplementation(async () => true);
		const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

		await service.getAsset(VALID_UUID, { width: 100 });

		expect(storageRead).toHaveBeenCalled();
		const readPaths = storageRead.mock.calls.map((call) => call[0]);
		expect(readPaths.some((name) => name.startsWith('11111111-2222-4333-8444-555555555555__'))).toBe(true);
	});
});
