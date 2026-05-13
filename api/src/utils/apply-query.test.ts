import type { Accountability, Permission, SchemaOverview } from '@cairncms/types';
import knex from 'knex';
import { describe, expect, it } from 'vitest';
import { applySearch } from './apply-query.js';

const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';

function makeField(name: string, type: 'string' | 'integer' | 'uuid' = 'string'): any {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type === 'integer' ? 'integer' : type === 'uuid' ? 'uuid' : 'varchar',
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
					rank: makeField('rank', 'integer'),
				},
			},
		},
		relations: [],
	} as unknown as SchemaOverview;
}

function makeBuilder() {
	return knex.default({ client: 'sqlite3', useNullAsDefault: true }).from('notes').select('*');
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
		permissions: [makePermission(['title', 'body'])],
		...overrides,
	};
}

describe('applySearch — field-permission scoping (GHSA-7wq3-jr35-275c)', () => {
	describe('bug-exposing — restricted field excluded from search', () => {
		it('non-admin caller with read permission on a subset of searchable fields scopes search to that subset', async () => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ permissions: [makePermission(['title', 'body'])] });

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('title');
			expect(sql).toContain('body');
			expect(sql).not.toContain('secret_note');
		});

		it('non-admin caller with empty read fields produces a forced-false predicate', async () => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ permissions: [makePermission([])] });

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('1 = 0');
			expect(sql).not.toContain('title');
			expect(sql).not.toContain('secret_note');
		});

		it('non-admin caller with no matching read permission for the collection produces a forced-false predicate', async () => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ permissions: [] });

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('1 = 0');
		});

		it('non-admin caller whose only allowed field has a non-matching type for the search term produces a forced-false predicate', async () => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ permissions: [makePermission(['id'])] });

			await applySearch(makeSchema(), dbQuery, 'not-a-uuid', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).not.toContain('LOWER(`notes`.`id`)');
			expect(sql).toContain('1 = 0');
		});
	});

	describe('regression guards — bypass paths preserved', () => {
		it('admin caller (admin === true) bypasses the filter and searches all type-matching fields', async () => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ admin: true, permissions: [] });

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('title');
			expect(sql).toContain('body');
			expect(sql).toContain('secret_note');
		});

		it('null accountability bypasses the filter (internal/trusted-caller convention)', async () => {
			const dbQuery = makeBuilder();

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', null);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('title');
			expect(sql).toContain('secret_note');
		});

		it('undefined accountability bypasses the filter (no accountability argument)', async () => {
			const dbQuery = makeBuilder();

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes');

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('title');
			expect(sql).toContain('secret_note');
		});

		it('wildcard fields (["*"]) on the read permission bypasses the field filter', async () => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ permissions: [makePermission(['*'])] });

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('title');
			expect(sql).toContain('secret_note');
		});
	});

	describe('public-role enumeration (the advisory PoC surface)', () => {
		it('public-role-shaped accountability with restricted read fields scopes search away from secret fields', async () => {
			const dbQuery = makeBuilder();

			const accountability: Accountability = {
				user: null,
				role: PUBLIC_ROLE_ID,
				admin: false,
				app: false,
				ip: '127.0.0.1',
				permissions: [
					{
						id: 99,
						role: PUBLIC_ROLE_ID,
						collection: 'notes',
						action: 'read',
						permissions: null,
						validation: null,
						presets: null,
						fields: ['title'],
					},
				],
			};

			await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).toContain('title');
			expect(sql).not.toContain('secret_note');
			expect(sql).not.toContain('body');
		});
	});
});
