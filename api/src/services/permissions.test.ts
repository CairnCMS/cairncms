import type { SchemaOverview } from '@cairncms/types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemSchema } from '../__utils__/schemas.js';
import { ItemsService } from './items.js';
import { PermissionsService } from './permissions.js';

vi.mock('../env', async () => {
	const actual = (await vi.importActual('../env')) as { default: Record<string, any> };

	const MOCK_ENV = {
		...actual.default,
		CACHE_AUTO_PURGE: false,
	};

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

vi.mock('../../src/database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn(),
}));

vi.mock('../cache', () => ({
	getCache: vi.fn().mockReturnValue({
		cache: { clear: vi.fn() },
		systemCache: { clear: vi.fn() },
	}),
	clearSystemCache: vi.fn(),
}));

const mutations = [
	{ name: 'createOne', run: (service: PermissionsService, opts: any) => service.createOne({}, opts) },
	{ name: 'createMany', run: (service: PermissionsService, opts: any) => service.createMany([{}], opts) },
	{ name: 'updateBatch', run: (service: PermissionsService, opts: any) => service.updateBatch([{}], opts) },
	{ name: 'updateMany', run: (service: PermissionsService, opts: any) => service.updateMany(['1'], {}, opts) },
	{ name: 'upsertMany', run: (service: PermissionsService, opts: any) => service.upsertMany([{}], opts) },
	{ name: 'deleteMany', run: (service: PermissionsService, opts: any) => service.deleteMany(['1'], opts) },
];

function createService() {
	return new PermissionsService({ knex: {} as any, schema: systemSchema as SchemaOverview });
}

describe('PermissionsService response cache invalidation', () => {
	beforeAll(() => {
		for (const { name } of mutations) {
			vi.spyOn(ItemsService.prototype, name as any).mockResolvedValue(undefined as any);
		}
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it.each(mutations)('$name clears the response cache when autoPurgeCache is not disabled', async ({ run }) => {
		const service = createService();

		await run(service, undefined);

		expect(service.cache!.clear).toHaveBeenCalledTimes(1);
	});

	it.each(mutations)('$name does not clear the response cache when autoPurgeCache is false', async ({ run }) => {
		const service = createService();

		await run(service, { autoPurgeCache: false });

		expect(service.cache!.clear).not.toHaveBeenCalled();
	});
});
