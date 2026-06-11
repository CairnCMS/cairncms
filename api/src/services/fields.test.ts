import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupPermissionsOnFieldDelete, FieldsService } from './fields.js';
import { sanitizeColumn } from '../utils/sanitize-schema.js';

vi.mock('../../src/database/index', () => ({
	__esModule: true,
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

vi.mock('@cairncms/schema', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@cairncms/schema')>();

	return {
		...actual,
		createInspector: vi.fn().mockReturnValue({ columnInfo: vi.fn() }),
	};
});

vi.mock('../utils/get-schema.js', () => ({
	getSchema: vi.fn().mockResolvedValue({ collections: {}, relations: [] }),
}));

describe('cleanupPermissionsOnFieldDelete (GHSA-9x5g-62gj-wqf2)', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;
	let trx: Knex.Transaction;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
		trx = db as unknown as Knex.Transaction;
	});

	afterEach(() => {
		tracker.reset();
	});

	it('removes the deleted field from a permission row that lists it explicitly', async () => {
		tracker.on
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 1, fields: ['title', 'secret'] }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(trx, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBe('title');
		expect(updates[0]!.bindings[updates[0]!.bindings.length - 1]).toBe(1);
	});

	it('writes null when the filtered fields array would be empty', async () => {
		tracker.on
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 10, fields: ['secret'] }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(trx, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBeNull();
	});

	it('preserves a wildcard fields array', async () => {
		tracker.on
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 2, fields: ['*'] }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push(q);
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(trx, 'articles', 'secret');

		expect(updates.length).toBe(0);
	});

	it('handles CSV-string fields by splitting before filtering', async () => {
		tracker.on
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 3, fields: 'title,secret' }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(trx, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBe('title');
	});

	it('does not issue an UPDATE when the row has no references to the deleted field', async () => {
		tracker.on
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 6, fields: ['title'] }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push(q);
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(trx, 'articles', 'secret');

		expect(updates.length).toBe(0);
	});

	it('does not modify a permission row when only filter JSON or presets reference the deleted field', async () => {
		tracker.on.select('select "id", "fields" from "directus_permissions" where "collection" = ?').response([
			{
				id: 42,
				fields: ['title'],
				permissions: { _and: [{ secret: { _eq: 'tenant-a' } }, { title: { _nempty: true } }] },
				validation: { secret: { _eq: 'tenant-a' } },
				presets: { secret: 'tenant-a' },
			},
		]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push(q);
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(trx, 'articles', 'secret');

		expect(updates.length).toBe(0);
	});
});

describe('updateField column comparison basis', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;
	let ddl: string[];

	const fullColumn = {
		name: 'country_id',
		table: 'articles',
		data_type: 'integer',
		default_value: null,
		max_length: null,
		numeric_precision: 32,
		numeric_scale: 0,
		is_nullable: true,
		is_unique: false,
		is_primary_key: false,
		is_generated: false,
		generation_expression: null,
		has_auto_increment: false,
		foreign_key_table: 'countries',
		foreign_key_column: 'id',
		comment: '',
	};

	const schema = {
		collections: {
			articles: {
				collection: 'articles',
				primary: 'id',
				singleton: false,
				note: null,
				sortField: null,
				accountability: 'all',
				fields: {
					country_id: {
						field: 'country_id',
						type: 'integer',
						defaultValue: null,
						nullable: true,
						generated: false,
						precision: 32,
						scale: 0,
						special: [],
						note: null,
						dbType: 'integer',
						alias: false,
						validation: null,
					},
				},
			},
		},
		relations: [],
	};

	const snapshotOpts = { bypassLimits: true, autoPurgeSystemCache: false };

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	async function runUpdate(fieldSchema: Record<string, any>, opts?: Record<string, any>) {
		ddl = [];

		tracker.on.any(/alter table/i).response((q) => {
			ddl.push(q.sql);
			return [];
		});

		const service = new FieldsService({ knex: db as unknown as Knex, schema: schema as any });

		(service as any).schemaInspector = {
			columnInfo: vi.fn().mockResolvedValue({ ...fullColumn }),
		};

		await service.updateField(
			'articles',
			{ collection: 'articles', field: 'country_id', type: 'integer', schema: fieldSchema } as any,
			opts as any
		);
	}

	it('does not alter the table when a round-tripped payload matches the full column', async () => {
		await runUpdate({ ...fullColumn });

		expect(ddl.length).toBe(0);
	});

	it('does not alter the table when snapshot application supplies the sanitized column shape', async () => {
		await runUpdate(sanitizeColumn({ ...fullColumn } as any), snapshotOpts);

		expect(ddl.length).toBe(0);
	});

	it('compares against the sanitized column during snapshot application', async () => {
		await runUpdate({ ...fullColumn }, snapshotOpts);

		expect(ddl.length).toBeGreaterThan(0);
	});
});
