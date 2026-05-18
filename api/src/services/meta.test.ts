import type { Accountability, Permission, SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaService } from './meta.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

function makeField(name: string, type: 'string' | 'uuid' = 'string'): any {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type === 'uuid' ? 'uuid' : 'varchar',
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
	};
}

function makeSchema(): SchemaOverview {
	return {
		collections: {
			notes: {
				collection: 'notes',
				primary: 'id',
				singleton: false,
				sortField: null,
				note: null,
				accountability: null,
				fields: {
					id: makeField('id', 'uuid'),
					title: makeField('title'),
					body: makeField('body'),
					secret_note: makeField('secret_note'),
				},
			},
		},
		relations: [],
	} as unknown as SchemaOverview;
}

function makePermission(fields: string[] | null): Permission {
	return {
		id: 1,
		role: 'role-uuid',
		collection: 'notes',
		action: 'read',
		permissions: null,
		validation: null,
		presets: null,
		fields,
	};
}

function makeAccountability(overrides: Partial<Accountability> = {}): Accountability {
	return {
		user: 'user-uuid',
		role: 'role-uuid',
		admin: false,
		app: true,
		ip: '127.0.0.1',
		permissions: [makePermission(['id', 'title'])],
		...overrides,
	};
}

const ROW_ID = '11111111-1111-1111-1111-111111111111';

describe('MetaService.filterCount — search scoped by read permissions (GHSA-7wq3-jr35-275c follow-up)', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			useNullAsDefault: true,
			connection: ':memory:',
			pool: { min: 1, max: 1 },
		});

		await db.schema.createTable('notes', (table) => {
			table.uuid('id').primary();
			table.string('title');
			table.string('body');
			table.string('secret_note');
		});

		await db('notes').insert({
			id: ROW_ID,
			title: 'public-row',
			body: 'plain-body',
			secret_note: 'hidden-value-xyz',
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	function makeService(accountability: Accountability | null): MetaService {
		return new MetaService({ knex: db, schema: makeSchema(), accountability });
	}

	describe('bug-exposing — non-admin filter_count search scopes to permitted fields', () => {
		it('non-admin with read permission on [id, title] does not find a row whose match is in secret_note', async () => {
			const accountability = makeAccountability({ permissions: [makePermission(['id', 'title'])] });
			const count = await makeService(accountability).filterCount('notes', { search: 'hidden-value-xyz' });
			expect(count).toBe(0);
		});

		it('non-admin with empty read fields emits a forced-false predicate', async () => {
			const accountability = makeAccountability({ permissions: [makePermission([])] });
			const count = await makeService(accountability).filterCount('notes', { search: 'hidden-value-xyz' });
			expect(count).toBe(0);
		});
	});

	describe('regression — permitted-field search and admin path continue to work', () => {
		it('non-admin with read permission on [id, title, secret_note] finds the row via secret_note', async () => {
			const accountability = makeAccountability({
				permissions: [makePermission(['id', 'title', 'secret_note'])],
			});

			const count = await makeService(accountability).filterCount('notes', { search: 'hidden-value-xyz' });
			expect(count).toBe(1);
		});

		it('non-admin with wildcard read permission finds the row', async () => {
			const accountability = makeAccountability({ permissions: [makePermission(['*'])] });
			const count = await makeService(accountability).filterCount('notes', { search: 'hidden-value-xyz' });
			expect(count).toBe(1);
		});

		it('admin caller searches all non-concealed fields', async () => {
			const accountability = makeAccountability({ admin: true, permissions: [] });
			const count = await makeService(accountability).filterCount('notes', { search: 'hidden-value-xyz' });
			expect(count).toBe(1);
		});

		it('non-admin filter_count without a search returns the inserted row count', async () => {
			const accountability = makeAccountability({ permissions: [makePermission(['id', 'title'])] });
			const count = await makeService(accountability).filterCount('notes', {});
			expect(count).toBe(1);
		});

		it('admin filter_count without a filter and without a search returns the total row count', async () => {
			const accountability = makeAccountability({ admin: true, permissions: [] });
			const count = await makeService(accountability).filterCount('notes', {});
			expect(count).toBe(1);
		});
	});
});
