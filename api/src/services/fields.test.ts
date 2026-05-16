import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupPermissionsOnFieldDelete } from './fields.js';

vi.mock('../../src/database/index', () => ({
	__esModule: true,
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

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
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 1, fields: ['title', 'secret'] }]);

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
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 10, fields: ['secret'] }]);

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
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 2, fields: ['*'] }]);

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
			.select('select "id", "fields" from "directus_permissions" where "collection" = ?')
			.response([{ id: 3, fields: 'title,secret' }]);

		const updates: any[] = [];

		tracker.on.update('directus_permissions').response((q) => {
			updates.push({ bindings: q.bindings });
			return 1;
		});

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

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

		await cleanupPermissionsOnFieldDelete(db, 'articles', 'secret');

		expect(updates.length).toBe(0);
	});
});
