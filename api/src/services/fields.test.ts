import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupPermissionsOnFieldDelete, removeFieldFromFilter } from './fields.js';

vi.mock('../../src/database/index', () => ({
	__esModule: true,
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

describe('removeFieldFromFilter (GHSA-9x5g-62gj-wqf2)', () => {
	it('returns null when given null', () => {
		expect(removeFieldFromFilter(null, 'secret')).toBeNull();
	});

	it('returns empty object unchanged', () => {
		expect(removeFieldFromFilter({}, 'secret')).toEqual({});
	});

	it('drops a single-key clause matching the deleted field', () => {
		expect(removeFieldFromFilter({ secret: { _eq: 'x' } }, 'secret')).toEqual({});
	});

	it('preserves sibling clauses keyed by non-deleted fields', () => {
		expect(removeFieldFromFilter({ secret: { _eq: 'x' }, title: { _neq: '' } }, 'secret')).toEqual({
			title: { _neq: '' },
		});
	});

	it('drops the deleted-field clause inside an _and array', () => {
		expect(removeFieldFromFilter({ _and: [{ secret: { _eq: 'x' } }, { title: { _neq: '' } }] }, 'secret')).toEqual({
			_and: [{ title: { _neq: '' } }],
		});
	});

	it('removes _and entirely when all its clauses reference only the deleted field', () => {
		expect(removeFieldFromFilter({ _and: [{ secret: { _eq: 'x' } }] }, 'secret')).toEqual({});
	});

	it('drops the deleted-field clause inside an _or array', () => {
		expect(removeFieldFromFilter({ _or: [{ secret: { _eq: 'x' } }, { title: { _neq: '' } }] }, 'secret')).toEqual({
			_or: [{ title: { _neq: '' } }],
		});
	});

	it('recurses through nested _and / _or', () => {
		const input = {
			_or: [{ _and: [{ secret: { _eq: 'x' } }, { title: { _neq: '' } }] }, { secret: { _eq: 'y' } }],
		};

		expect(removeFieldFromFilter(input, 'secret')).toEqual({ _or: [{ _and: [{ title: { _neq: '' } }] }] });
	});

	it('does not recurse into relational-filter values (cross-collection cleanup is out of scope)', () => {
		const input = { author: { secret: { _eq: 'x' } } };
		expect(removeFieldFromFilter(input, 'secret')).toEqual(input);
	});

	it('keeps unrelated top-level keys when only one references the deleted field', () => {
		const input = { title: { _eq: 'x' }, body: { _eq: 'y' } };
		expect(removeFieldFromFilter(input, 'secret')).toEqual(input);
	});
});

describe('cleanupPermissionsOnFieldDelete (GHSA-9x5g-62gj-wqf2)', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	it('removes the deleted field from a permission row that lists it explicitly', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([{ id: 1, fields: ['title', 'secret'], permissions: null, validation: null }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBe('title');
		expect(updates[0]!.bindings[updates[0]!.bindings.length - 1]).toBe(1);
	});

	it('writes null when the filtered fields array would be empty', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([{ id: 10, fields: ['secret'], permissions: null, validation: null }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBeNull();
	});

	it('preserves a wildcard fields array', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([{ id: 2, fields: ['*'], permissions: null, validation: null }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push(q);
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(0);
	});

	it('handles CSV-string fields by splitting before filtering', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([{ id: 3, fields: 'title,secret', permissions: null, validation: null }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBe('title');
	});

	it('cleans a JSON-string permissions filter and writes back a JSON string', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([
				{
					id: 4,
					fields: null,
					permissions: JSON.stringify({ secret: { _eq: 'x' }, title: { _neq: '' } }),
					validation: null,
				},
			]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(JSON.parse(updates[0]!.bindings[0] as string)).toEqual({ title: { _neq: '' } });
	});

	it('cleans validation filter alongside permissions filter on the same row', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([
				{
					id: 5,
					fields: null,
					permissions: JSON.stringify({ secret: { _eq: 'x' } }),
					validation: JSON.stringify({ secret: { _eq: 'x' } }),
				},
			]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(1);
		expect(updates[0]!.bindings[0]).toBe('{}');
		expect(updates[0]!.bindings[1]).toBe('{}');
	});

	it('does not issue an UPDATE when the row has no references to the deleted field', async () => {
		tracker.on
			.select('select "id", "fields", "permissions", "validation" from "directus_permissions" where "collection" = ?')
			.response([
				{
					id: 6,
					fields: ['title'],
					permissions: JSON.stringify({ title: { _eq: 'x' } }),
					validation: null,
				},
			]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push(q);
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(0);
	});
});
