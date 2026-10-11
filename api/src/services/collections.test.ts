import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInspector } = vi.hoisted(() => ({
	mockInspector: {
		overview: vi.fn(),
		tableInfo: vi.fn(),
		foreignKeys: vi.fn(),
	},
}));

vi.mock('@cairncms/schema', async (importOriginal) => ({
	...(await importOriginal<typeof import('@cairncms/schema')>()),
	createInspector: () => mockInspector,
}));

vi.mock('../../src/database/index', () => ({
	__esModule: true,
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

import { ForbiddenException } from '../exceptions/index.js';
import { CollectionsService } from './collections.js';
import { ItemsService } from './items.js';

const admin = { role: 'admin', admin: true } as any;

describe('CollectionsService schema-apply refusals', () => {
	let db: any;
	let tracker: Tracker;
	let writes: string[];

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
		writes = [];

		tracker.on.any(/create table|drop table|alter table|insert into|update |delete from/i).response((q) => {
			writes.push(q.sql);
			return [];
		});
	});

	afterEach(() => {
		tracker.reset();
		mockInspector.overview.mockReset();
		mockInspector.tableInfo.mockReset();
		mockInspector.foreignKeys.mockReset();
		vi.restoreAllMocks();
	});

	function service(schema: Record<string, any>) {
		return new CollectionsService({ knex: db, schema: schema as any, accountability: admin });
	}

	it('createOne refuses the directus_ prefix before any write', async () => {
		await expect(
			service({ collections: {}, relations: [] }).createOne({
				collection: 'directus_articles',
				schema: {},
				meta: { note: 'unused' },
			} as any)
		).rejects.toThrow(`Collections can't start with "directus_"`);

		expect(writes).toEqual([]);
	});

	it('createOne refuses a collection that already exists before any write', async () => {
		tracker.on.select('directus_collections').response([]);

		await expect(
			service({ collections: { articles: { collection: 'articles' } }, relations: [] }).createOne({
				collection: 'articles',
				schema: {},
				meta: { note: 'unused' },
			} as any)
		).rejects.toThrow('Collection "articles" already exists.');

		expect(writes).toEqual([]);
	});

	it('deleteOne refuses a collection that does not exist before any write', async () => {
		mockInspector.tableInfo.mockResolvedValue([]);
		vi.spyOn(ItemsService.prototype, 'readByQuery').mockResolvedValue([] as any);

		await expect(service({ collections: {}, relations: [] }).deleteOne('ghost')).rejects.toBeInstanceOf(
			ForbiddenException
		);

		expect(writes).toEqual([]);
	});
});
