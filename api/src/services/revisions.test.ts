import type { Knex } from 'knex';
import knex from 'knex';
import { MockClient } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemSchema } from '../__utils__/schemas.js';
import { getCache } from '../cache.js';
import { ItemsService } from './items.js';
import { RevisionsService } from './revisions.js';

vi.mock('../env', async () => {
	const actual = (await vi.importActual('../env')) as { default: Record<string, any> };

	const MOCK_ENV = {
		...actual.default,
		CACHE_AUTO_PURGE: true,
	};

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn(),
}));

vi.mock('../cache', () => ({
	getCache: vi.fn(),
}));

describe('RevisionsService', () => {
	let db: MockedFunction<Knex>;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
	});

	beforeEach(() => {
		vi.mocked(getCache).mockReturnValue({
			cache: null,
			systemCache: { clear: vi.fn() },
		} as unknown as ReturnType<typeof getCache>);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const service = () => new RevisionsService({ knex: db, accountability: null, schema: systemSchema });

	it('defaults autoPurgeCache to false and bypassLimits to true when options are omitted', async () => {
		const createOne = vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue(1);

		await service().createOne({ foo: 'bar' });

		expect(createOne).toHaveBeenCalledWith({ foo: 'bar' }, { autoPurgeCache: false, bypassLimits: true });
	});

	it('applies the defaults across createMany, updateOne, and updateMany', async () => {
		const createMany = vi.spyOn(ItemsService.prototype, 'createMany').mockResolvedValue([1]);
		const updateOne = vi.spyOn(ItemsService.prototype, 'updateOne').mockResolvedValue(1);
		const updateMany = vi.spyOn(ItemsService.prototype, 'updateMany').mockResolvedValue([1]);

		const revisions = service();
		await revisions.createMany([{ foo: 'bar' }]);
		await revisions.updateOne(1, { foo: 'bar' });
		await revisions.updateMany([1], { foo: 'bar' });

		expect(createMany).toHaveBeenCalledWith([{ foo: 'bar' }], { autoPurgeCache: false, bypassLimits: true });
		expect(updateOne).toHaveBeenCalledWith(1, { foo: 'bar' }, { autoPurgeCache: false, bypassLimits: true });
		expect(updateMany).toHaveBeenCalledWith([1], { foo: 'bar' }, { autoPurgeCache: false, bypassLimits: true });
	});

	it('preserves an explicit bypassLimits false and does not mutate the caller options', async () => {
		const createOne = vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue(1);
		const opts = { bypassLimits: false };

		await service().createOne({ foo: 'bar' }, opts);

		expect(createOne).toHaveBeenCalledWith({ foo: 'bar' }, { autoPurgeCache: false, bypassLimits: false });
		expect(opts).toEqual({ bypassLimits: false });
	});
});
