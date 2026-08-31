import type { SchemaOverview } from '@cairncms/types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemSchema } from '../__utils__/schemas.js';
import { ForbiddenException, InvalidCredentialsException, InvalidPayloadException } from '../exceptions/index.js';
import { ItemsService } from './items.js';
import { PermissionsService } from './permissions.js';

const { checkAccessMock } = vi.hoisted(() => ({ checkAccessMock: vi.fn() }));

vi.mock('./authorization.js', () => ({
	AuthorizationService: vi.fn(() => ({ checkAccess: checkAccessMock })),
}));

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

describe('PermissionsService getItemPermissions', () => {
	const stringField = { field: 'id', type: 'string' } as any;
	const uuidField = { field: 'id', type: 'uuid' } as any;

	function makeSchema(): SchemaOverview {
		return {
			collections: {
				articles: { collection: 'articles', primary: 'id', singleton: false, fields: { id: stringField } },
				site_config: { collection: 'site_config', primary: 'id', singleton: true, fields: { id: stringField } },
				docs: { collection: 'docs', primary: 'id', singleton: false, fields: { id: uuidField } },
				directus_shares: {
					collection: 'directus_shares',
					primary: 'id',
					singleton: false,
					fields: { id: stringField },
				},
			},
			relations: [],
		} as unknown as SchemaOverview;
	}

	function makeKnex(row: any) {
		const chain: any = {
			select: vi.fn(() => chain),
			from: vi.fn(() => chain),
			where: vi.fn(() => chain),
			first: vi.fn(() => Promise.resolve(row)),
		};

		return chain;
	}

	function makeServiceWithKnex(row: any, accountability: any) {
		const knex = makeKnex(row);
		const service = new PermissionsService({ knex: knex as any, schema: makeSchema(), accountability });
		return { service, knex };
	}

	function makeService(row: any, accountability: any) {
		return makeServiceWithKnex(row, accountability).service;
	}

	function allowActions(...allowed: string[]) {
		checkAccessMock.mockImplementation(async (action: string) => {
			if (allowed.includes(action)) return;
			throw new ForbiddenException();
		});
	}

	const DENIED = {
		update: { access: false, fields: null },
		delete: { access: false },
		share: { access: false },
	};

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('grants update to a caller with update but not read access, and reports its editable fields', async () => {
		allowActions('update');

		const accountability = {
			user: 'u',
			admin: false,
			permissions: [{ collection: 'articles', action: 'update', fields: ['title', 'body'] }],
		};

		const result = await makeService({ id: '5' }, accountability).getItemPermissions('articles', '5');

		expect(result).toEqual({
			update: { access: true, fields: ['title', 'body'] },
			delete: { access: false },
			share: { access: false },
		});

		expect(checkAccessMock).toHaveBeenCalledTimes(3);
		expect(checkAccessMock).toHaveBeenCalledWith('update', 'articles', '5');
		expect(checkAccessMock).toHaveBeenCalledWith('delete', 'articles', '5');
		expect(checkAccessMock).toHaveBeenCalledWith('share', 'articles', '5');
	});

	it('reports an empty editable-field list for a legacy empty-fields update permission', async () => {
		allowActions('update');

		const accountability = {
			user: 'u',
			admin: false,
			permissions: [{ collection: 'articles', action: 'update', fields: [] }],
		};

		const result = await makeService({ id: '5' }, accountability).getItemPermissions('articles', '5');

		expect(result.update).toEqual({ access: true, fields: [] });
	});

	it('returns all access with wildcard fields for an admin on an existing item', async () => {
		allowActions('update', 'delete', 'share');

		const result = await makeService({ id: '5' }, { user: 'u', admin: true, permissions: [] }).getItemPermissions(
			'articles',
			'5'
		);

		expect(result).toEqual({
			update: { access: true, fields: ['*'] },
			delete: { access: true },
			share: { access: true },
		});
	});

	it('returns the denied shape when no action is allowed', async () => {
		allowActions();

		const result = await makeService({ id: '5' }, { user: 'u', admin: false, permissions: [] }).getItemPermissions(
			'articles',
			'5'
		);

		expect(result).toEqual(DENIED);
	});

	it('returns the denied shape for a nonexistent item without checking access', async () => {
		allowActions('update', 'delete', 'share');

		const result = await makeService(undefined, { user: 'u', admin: true, permissions: [] }).getItemPermissions(
			'articles',
			'missing'
		);

		expect(result).toEqual(DENIED);
		expect(checkAccessMock).not.toHaveBeenCalled();
	});

	it('returns the denied shape for an unknown collection addressed with a key', async () => {
		const result = await makeService({ id: '5' }, { user: 'u', admin: true, permissions: [] }).getItemPermissions(
			'nonexistent',
			'5'
		);

		expect(result).toEqual(DENIED);
	});

	it('rejects an unknown collection without a key', async () => {
		const service = makeService({ id: '5' }, { user: 'u', admin: true, permissions: [] });

		await expect(service.getItemPermissions('nonexistent')).rejects.toThrow(InvalidPayloadException);
	});

	it('rejects an ordinary collection without a key', async () => {
		const service = makeService({ id: '5' }, { user: 'u', admin: true, permissions: [] });

		await expect(service.getItemPermissions('articles')).rejects.toThrow(InvalidPayloadException);
	});

	it('resolves an existing singleton without a key', async () => {
		allowActions('update', 'delete', 'share');

		const result = await makeService({ id: '1' }, { user: 'u', admin: true, permissions: [] }).getItemPermissions(
			'site_config'
		);

		expect(result.update.access).toBe(true);
		expect(checkAccessMock).toHaveBeenCalledWith('update', 'site_config', '1');
	});

	it('returns the denied shape for an empty singleton', async () => {
		allowActions('update', 'delete', 'share');

		const result = await makeService(undefined, { user: 'u', admin: true, permissions: [] }).getItemPermissions(
			'site_config'
		);

		expect(result).toEqual(DENIED);
	});

	it('grants share on directus_shares to a permitted caller', async () => {
		allowActions('share');

		const result = await makeService({ id: '5' }, { user: 'u', admin: false, permissions: [] }).getItemPermissions(
			'directus_shares',
			'5'
		);

		expect(result.share.access).toBe(true);
		expect(result.update.access).toBe(false);
	});

	it('propagates an operational failure instead of returning denied', async () => {
		checkAccessMock.mockRejectedValue(new Error('db down'));

		const service = makeService({ id: '5' }, { user: 'u', admin: false, permissions: [] });

		await expect(service.getItemPermissions('articles', '5')).rejects.toThrow('db down');
	});

	it('rejects an unauthenticated caller before any query or access check', async () => {
		const { service, knex } = makeServiceWithKnex({ id: '5' }, { admin: false, permissions: [] });

		await expect(service.getItemPermissions('articles', '5')).rejects.toThrow(InvalidCredentialsException);
		expect(knex.select).not.toHaveBeenCalled();
		expect(checkAccessMock).not.toHaveBeenCalled();
	});

	it('returns the denied shape for a crafted inherited-property collection name', async () => {
		const { service, knex } = makeServiceWithKnex({ id: '5' }, { user: 'u', admin: true, permissions: [] });

		expect(await service.getItemPermissions('constructor', '5')).toEqual(DENIED);
		expect(await service.getItemPermissions('__proto__', '5')).toEqual(DENIED);
		expect(knex.select).not.toHaveBeenCalled();
		expect(checkAccessMock).not.toHaveBeenCalled();
	});

	it('returns the denied shape for a malformed primary key without querying', async () => {
		const { service, knex } = makeServiceWithKnex({ id: '5' }, { user: 'u', admin: true, permissions: [] });

		expect(await service.getItemPermissions('docs', 'not-a-uuid')).toEqual(DENIED);
		expect(knex.select).not.toHaveBeenCalled();
		expect(checkAccessMock).not.toHaveBeenCalled();
	});
});
