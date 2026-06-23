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

import { ForbiddenException } from '../exceptions/index.js';
import { CollectionsService } from '../services/collections.js';
import { ExportService, ImportService } from '../services/import-export.js';
import { ItemsService } from '../services/items.js';
import { RelationsService } from '../services/relations.js';
import { getSchema } from '../utils/get-schema.js';
import { getInternalTables, isInternalTable, registerInternalTable } from './internal-tables.js';

class Client_PG extends MockClient {}

const FIXTURE = 'cairncms_internal_test_fixture';
const NORMAL = 'articles';

const admin = { role: 'admin', admin: true } as any;
const emptySchema = { collections: {}, relations: [] } as any;

const collectionMeta = (collection: string) => ({
	accountability: 'all',
	collection,
	group: null,
	hidden: false,
	icon: null,
	item_duplication_fields: null,
	note: null,
	singleton: false,
	translations: null,
});

const relationMeta = (many_collection: string, one_collection: string, many_field: string) => ({
	id: 1,
	many_collection,
	many_field,
	one_collection,
	one_field: null,
	one_collection_field: null,
	one_allowed_collections: null,
	junction_field: null,
	sort_field: null,
	one_deselect_action: 'nullify',
});

describe('internal-table classification', () => {
	let db: any;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
		registerInternalTable(FIXTURE);
	});

	afterEach(() => {
		tracker.reset();
		mockInspector.overview.mockReset();
		mockInspector.tableInfo.mockReset();
		mockInspector.foreignKeys.mockReset();
		vi.restoreAllMocks();
	});

	it('classifies a registered table and exposes it through the iterating accessor', () => {
		expect(isInternalTable(FIXTURE)).toBe(true);
		expect(isInternalTable(NORMAL)).toBe(false);
		expect(getInternalTables()).toContain(FIXTURE);
	});

	it('getSchema excludes a registered internal table from SchemaOverview.collections', async () => {
		const columns = {
			id: { column_name: 'id', data_type: 'integer', is_nullable: false, is_generated: false },
		};

		mockInspector.overview.mockResolvedValue({
			[FIXTURE]: { primary: 'id', columns },
			[NORMAL]: { primary: 'id', columns },
		});

		tracker.on.select('directus_collections').response([]);
		tracker.on.select('directus_fields').response([]);
		vi.spyOn(RelationsService.prototype, 'readAll').mockResolvedValue([]);

		const schema = await getSchema({ database: db, bypassCache: true });

		expect(Object.keys(schema.collections)).toContain(NORMAL);
		expect(Object.keys(schema.collections)).not.toContain(FIXTURE);
	});

	it('getSchema excludes every registered internal table, so a newly registered table is auto-covered', async () => {
		const columns = {
			id: { column_name: 'id', data_type: 'integer', is_nullable: false, is_generated: false },
		};

		const registered = getInternalTables();

		const overview: Record<string, { primary: string; columns: typeof columns }> = {
			[NORMAL]: { primary: 'id', columns },
		};

		for (const table of registered) overview[table] = { primary: 'id', columns };

		mockInspector.overview.mockResolvedValue(overview);
		tracker.on.select('directus_collections').response([]);
		tracker.on.select('directus_fields').response([]);
		vi.spyOn(RelationsService.prototype, 'readAll').mockResolvedValue([]);

		const schema = await getSchema({ database: db, bypassCache: true });

		expect(registered).toContain('cairncms_extension_settings');
		expect(Object.keys(schema.collections)).toContain(NORMAL);

		for (const table of registered) {
			expect(Object.keys(schema.collections)).not.toContain(table);
		}
	});

	it('CollectionsService.readByQuery excludes an internal table on both the physical and metadata paths', async () => {
		mockInspector.tableInfo.mockResolvedValue([{ name: FIXTURE }, { name: NORMAL }]);

		vi.spyOn(ItemsService.prototype, 'readByQuery').mockResolvedValue([
			collectionMeta(FIXTURE),
			collectionMeta(NORMAL),
		] as any);

		const service = new CollectionsService({ knex: db, schema: emptySchema, accountability: admin });
		const names = (await service.readByQuery()).map((collection) => collection.collection);

		expect(names).toContain(NORMAL);
		expect(names).not.toContain(FIXTURE);
	});

	it('RelationsService.readAll excludes relations on or pointing to an internal table', async () => {
		mockInspector.foreignKeys.mockResolvedValue([]);

		vi.spyOn(ItemsService.prototype, 'readByQuery').mockResolvedValue([
			relationMeta(FIXTURE, NORMAL, 'owner'),
			relationMeta(NORMAL, FIXTURE, 'fixture_ref'),
			relationMeta(NORMAL, 'directus_users', 'author'),
		] as any);

		const service = new RelationsService({ knex: db, schema: emptySchema, accountability: admin });
		const relations = await service.readAll();

		expect(relations.some((relation) => relation.collection === FIXTURE)).toBe(false);
		expect(relations.some((relation) => relation.related_collection === FIXTURE)).toBe(false);
		expect(relations.some((relation) => relation.collection === NORMAL && relation.field === 'author')).toBe(true);
	});

	it('RelationsService.readOne fails closed when the queried collection is internal', async () => {
		mockInspector.foreignKeys.mockResolvedValue([]);

		vi.spyOn(ItemsService.prototype, 'readByQuery').mockResolvedValue([relationMeta(FIXTURE, NORMAL, 'owner')] as any);

		const service = new RelationsService({ knex: db, schema: emptySchema, accountability: admin });

		await expect(service.readOne(FIXTURE, 'owner')).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('RelationsService.readOne fails closed when the relation points at an internal table', async () => {
		mockInspector.foreignKeys.mockResolvedValue([]);

		vi.spyOn(ItemsService.prototype, 'readByQuery').mockResolvedValue([
			relationMeta(NORMAL, FIXTURE, 'fixture_ref'),
		] as any);

		const service = new RelationsService({ knex: db, schema: emptySchema, accountability: admin });

		await expect(service.readOne(NORMAL, 'fixture_ref')).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('ImportService.import and ExportService.exportToFile fail closed for an internal table', async () => {
		const importService = new ImportService({ knex: db, schema: emptySchema, accountability: admin });
		const exportService = new ExportService({ knex: db, schema: emptySchema, accountability: admin });

		await expect(importService.import(FIXTURE, 'application/json', null as any)).rejects.toBeInstanceOf(
			ForbiddenException
		);

		await expect(exportService.exportToFile(FIXTURE, {}, 'json')).rejects.toBeInstanceOf(ForbiddenException);
	});
});
