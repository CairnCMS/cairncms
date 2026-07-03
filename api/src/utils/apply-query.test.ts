import type { Accountability, Aggregate, Permission, Query, SchemaOverview } from '@cairncms/types';
import knex from 'knex';
import { describe, expect, it } from 'vitest';
import { InvalidQueryException } from '../exceptions/invalid-query.js';
import applyQuery, { applyFilter, applySearch, applySort, validateGroupOperands } from './apply-query.js';

const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';

const DB_TYPE_BY_FIELD_TYPE: Record<'string' | 'integer' | 'uuid', string> = {
	string: 'varchar',
	integer: 'integer',
	uuid: 'uuid',
};

function makeField(name: string, type: 'string' | 'integer' | 'uuid' = 'string', special: string[] = []): any {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: DB_TYPE_BY_FIELD_TYPE[type],
		precision: null,
		scale: null,
		special,
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
					secret_token: makeField('secret_token', 'string', ['conceal']),
					rank: makeField('rank', 'integer'),
				},
			},
		},
		relations: [],
	} as unknown as SchemaOverview;
}

function makeRelationalSchema(): SchemaOverview {
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
					author: makeField('author', 'uuid'),
				},
			},
			users: {
				collection: 'users',
				primary: 'id',
				singleton: false,
				sortField: null,
				note: null,
				accountability: null,
				fields: {
					id: makeField('id', 'uuid'),
					name: makeField('name'),
					tfa_secret: makeField('tfa_secret', 'string', ['conceal']),
				},
			},
		},
		relations: [
			{
				collection: 'notes',
				field: 'author',
				related_collection: 'users',
				schema: null,
				meta: null,
			},
		],
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

describe('applySearch — conceal-field exclusion (GHSA-8jpw-gpr4-8cmh)', () => {
	it('non-admin with read permission on a concealed field still does not search it', async () => {
		const dbQuery = makeBuilder();
		const accountability = makeAccountability({ permissions: [makePermission(['title', 'secret_token'])] });

		await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

		const { sql } = dbQuery.toSQL();

		expect(sql).toContain('title');
		expect(sql).not.toContain('secret_token');
	});

	it('admin caller (admin === true) does not search concealed fields', async () => {
		const dbQuery = makeBuilder();
		const accountability = makeAccountability({ admin: true, permissions: [] });

		await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

		const { sql } = dbQuery.toSQL();

		expect(sql).toContain('title');
		expect(sql).toContain('body');
		expect(sql).not.toContain('secret_token');
	});

	it('trusted/null-accountability caller does not search concealed fields', async () => {
		const dbQuery = makeBuilder();

		await applySearch(makeSchema(), dbQuery, 'foo', 'notes', null);

		const { sql } = dbQuery.toSQL();

		expect(sql).toContain('title');
		expect(sql).not.toContain('secret_token');
	});

	it('wildcard ["*"] permission does not widen search to concealed fields', async () => {
		const dbQuery = makeBuilder();
		const accountability = makeAccountability({ permissions: [makePermission(['*'])] });

		await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

		const { sql } = dbQuery.toSQL();

		expect(sql).toContain('title');
		expect(sql).toContain('secret_note');
		expect(sql).not.toContain('secret_token');
	});

	it('non-concealed permitted fields are still searched (regression)', async () => {
		const dbQuery = makeBuilder();
		const accountability = makeAccountability({ permissions: [makePermission(['title'])] });

		await applySearch(makeSchema(), dbQuery, 'foo', 'notes', accountability);

		const { sql } = dbQuery.toSQL();

		expect(sql).toContain('title');
		expect(sql).not.toContain('secret_token');
	});
});

describe('applySearch — numeric field accepts only decimal values', () => {
	it.each(['0x56071c902718e681e274DB0AaC9B4Ed2d027924d', '0b11111', '0.42e3', 'Infinity', '42.000'])(
		'does not match %s against a numeric field',
		async (value) => {
			const dbQuery = makeBuilder();
			const accountability = makeAccountability({ permissions: [makePermission(['rank'])] });

			await applySearch(makeSchema(), dbQuery, value, 'notes', accountability);

			const { sql } = dbQuery.toSQL();

			expect(sql).not.toContain('rank');
			expect(sql).toContain('1 = 0');
		}
	);

	it.each(['1234', '-128', '12.34'])('matches decimal %s against a numeric field', async (value) => {
		const dbQuery = makeBuilder();
		const accountability = makeAccountability({ permissions: [makePermission(['rank'])] });

		await applySearch(makeSchema(), dbQuery, value, 'notes', accountability);

		const { sql, bindings } = dbQuery.toSQL();

		expect(sql).toContain('rank');
		expect(bindings).toContain(Number(value));
	});
});

describe('applySort — unknown column validation', () => {
	function callApplySort(sort: string[]) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
		return applySort(knexInstance, makeSchema(), dbQuery, sort, 'notes', {});
	}

	describe('bug-exposing — unknown sort fields raise InvalidQueryException', () => {
		it('throws InvalidQueryException when the sort field does not exist', () => {
			expect(() => callApplySort(['sort'])).toThrow(InvalidQueryException);
		});

		it('throws InvalidQueryException with descending prefix on a missing field', () => {
			expect(() => callApplySort(['-sort'])).toThrow(InvalidQueryException);
		});

		it('throws InvalidQueryException when one of several sort fields is missing', () => {
			expect(() => callApplySort(['title', 'nonexistent'])).toThrow(InvalidQueryException);
		});

		it('error message names the unknown field', () => {
			expect(() => callApplySort(['nonexistent'])).toThrow(/nonexistent/);
		});
	});

	describe('regression — valid sorts continue to work', () => {
		it('accepts a known field ascending', () => {
			expect(() => callApplySort(['title'])).not.toThrow();
		});

		it('accepts a known field descending', () => {
			expect(() => callApplySort(['-title'])).not.toThrow();
		});

		it('accepts multiple known fields', () => {
			expect(() => callApplySort(['title', '-rank'])).not.toThrow();
		});
	});
});

describe('applyFilter — unknown field validation', () => {
	function callApplyFilter(filter: Record<string, any>) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
		return applyFilter(knexInstance, makeRelationalSchema(), dbQuery, filter, 'notes', {});
	}

	describe('bug-exposing — unknown filter fields raise InvalidQueryException', () => {
		it('throws InvalidQueryException for an unknown top-level filter key', () => {
			expect(() => callApplyFilter({ nonexistent: { _eq: 'x' } })).toThrow(InvalidQueryException);
		});

		it('throws InvalidQueryException for an unknown key nested under a relation', () => {
			expect(() => callApplyFilter({ author: { nonexistent: { _eq: 'x' } } })).toThrow(InvalidQueryException);
		});

		it('error message names the unknown key', () => {
			expect(() => callApplyFilter({ nonexistent: { _eq: 'x' } })).toThrow(/nonexistent/);
		});
	});

	describe('regression — valid filters continue to apply', () => {
		it('accepts a known top-level field filter', () => {
			expect(() => callApplyFilter({ title: { _eq: 'hello' } })).not.toThrow();
		});

		it('accepts a known nested relational field filter', () => {
			expect(() => callApplyFilter({ author: { name: { _eq: 'Ada' } } })).not.toThrow();
		});
	});
});

describe('applySort — nested relational sort validation', () => {
	function callApplySort(sort: string[]) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
		return applySort(knexInstance, makeRelationalSchema(), dbQuery, sort, 'notes', {});
	}

	describe('bug-exposing — unknown nested sort targets raise InvalidQueryException', () => {
		it('throws InvalidQueryException for an unknown field on the related collection', () => {
			expect(() => callApplySort(['author.nonexistent'])).toThrow(InvalidQueryException);
		});

		it('error message names the unknown sort target', () => {
			expect(() => callApplySort(['author.nonexistent'])).toThrow(/nonexistent/);
		});
	});

	describe('regression — valid nested sorts continue to work', () => {
		it('accepts a known field on the related collection', () => {
			expect(() => callApplySort(['author.name'])).not.toThrow();
		});
	});
});

describe('applyQuery — explicit accountability required when search is present (GHSA-7wq3-jr35-275c follow-up)', () => {
	function callApplyQuery(query: Parameters<typeof applyQuery>[3], options?: Parameters<typeof applyQuery>[5]) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
		return applyQuery(knexInstance, 'notes', dbQuery, query, makeSchema(), options);
	}

	describe('bug-exposing — missing accountability with a search throws', () => {
		it('throws when options is undefined and query.search is present', () => {
			expect(() => callApplyQuery({ search: 'foo' })).toThrow(InvalidQueryException);
		});

		it('throws when options is provided without an accountability key and query.search is present', () => {
			expect(() => callApplyQuery({ search: 'foo' }, {})).toThrow(InvalidQueryException);
		});

		it('error message names the accountability requirement', () => {
			expect(() => callApplyQuery({ search: 'foo' })).toThrow(/accountability/);
		});
	});

	describe('regression — explicit context and non-search paths continue to work', () => {
		it('does not throw when accountability is explicit null (trusted/system caller)', () => {
			expect(() => callApplyQuery({ search: 'foo' }, { accountability: null })).not.toThrow();
		});

		it('does not throw when accountability is a real Accountability', () => {
			const accountability = makeAccountability({ permissions: [makePermission(['title'])] });
			expect(() => callApplyQuery({ search: 'foo' }, { accountability })).not.toThrow();
		});

		it('does not throw when there is no search and no options', () => {
			expect(() => callApplyQuery({})).not.toThrow();
		});

		it('does not throw on filter-only queries without accountability', () => {
			expect(() => callApplyQuery({ filter: { title: { _eq: 'x' } } })).not.toThrow();
		});
	});
});

describe('applyAggregate — concealed operand rejection (GHSA-38hg-ww64-rrwc follow-up)', () => {
	function callApplyQuery(aggregate: Aggregate) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
		return applyQuery(knexInstance, 'notes', dbQuery, { aggregate }, makeSchema(), { accountability: null });
	}

	describe('bug-exposing — value-deriving aggregates on concealed operands raise InvalidQueryException', () => {
		it('throws on min over a concealed field', () => {
			expect(() => callApplyQuery({ min: ['secret_token'] })).toThrow(InvalidQueryException);
		});

		it('throws on max over a concealed field', () => {
			expect(() => callApplyQuery({ max: ['secret_token'] })).toThrow(InvalidQueryException);
		});

		it('throws on sum over a concealed field', () => {
			expect(() => callApplyQuery({ sum: ['secret_token'] })).toThrow(InvalidQueryException);
		});

		it('throws on sumDistinct over a concealed field', () => {
			expect(() => callApplyQuery({ sumDistinct: ['secret_token'] })).toThrow(InvalidQueryException);
		});

		it('throws on avg over a concealed field', () => {
			expect(() => callApplyQuery({ avg: ['secret_token'] })).toThrow(InvalidQueryException);
		});

		it('throws on avgDistinct over a concealed field', () => {
			expect(() => callApplyQuery({ avgDistinct: ['secret_token'] })).toThrow(InvalidQueryException);
		});

		it('error message names the operation and the concealed field', () => {
			expect(() => callApplyQuery({ min: ['secret_token'] })).toThrow(/min/);
			expect(() => callApplyQuery({ min: ['secret_token'] })).toThrow(/secret_token/);
		});
	});

	describe('regression — count-style aggregates on concealed operands continue to work', () => {
		it('accepts count over a concealed field', () => {
			expect(() => callApplyQuery({ count: ['secret_token'] })).not.toThrow();
		});

		it('accepts countDistinct over a concealed field', () => {
			expect(() => callApplyQuery({ countDistinct: ['secret_token'] })).not.toThrow();
		});

		it('accepts countAll (handled by applyAggregate but not in the Aggregate type)', () => {
			expect(() => callApplyQuery({ countAll: ['*'] } as unknown as Aggregate)).not.toThrow();
		});
	});

	describe('regression — value-deriving aggregates on non-concealed operands continue to work', () => {
		it('accepts min on title', () => {
			expect(() => callApplyQuery({ min: ['title'] })).not.toThrow();
		});

		it('accepts max on body', () => {
			expect(() => callApplyQuery({ max: ['body'] })).not.toThrow();
		});

		it('accepts sum on rank', () => {
			expect(() => callApplyQuery({ sum: ['rank'] })).not.toThrow();
		});
	});

	describe('regression — role-independence', () => {
		it('throws on concealed-field aggregate even when caller is admin', () => {
			const dbQuery = makeBuilder();
			const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });

			const adminAccountability: Accountability = {
				user: 'user-uuid',
				role: 'role-uuid',
				admin: true,
				app: true,
				ip: '127.0.0.1',
				permissions: [],
			};

			expect(() =>
				applyQuery(knexInstance, 'notes', dbQuery, { aggregate: { min: ['secret_token'] } }, makeSchema(), {
					accountability: adminAccountability,
				})
			).toThrow(InvalidQueryException);
		});
	});

	describe('regression — empty and absent aggregate queries', () => {
		it('does not throw when no aggregate is present', () => {
			const dbQuery = makeBuilder();
			const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });

			expect(() =>
				applyQuery(knexInstance, 'notes', dbQuery, {}, makeSchema(), { accountability: null })
			).not.toThrow();
		});

		it('does not throw on an empty aggregate object', () => {
			expect(() => callApplyQuery({})).not.toThrow();
		});

		it('does not throw on a value-deriving aggregate with an empty operand list', () => {
			expect(() => callApplyQuery({ min: [] })).not.toThrow();
		});
	});
});

describe('applySort — concealed operand rejection', () => {
	function callApplySort(sort: string[]) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
		return applySort(knexInstance, makeSchema(), dbQuery, sort, 'notes', {});
	}

	describe('bug-exposing — concealed sort operand raises InvalidQueryException', () => {
		it('throws on plain concealed field', () => {
			expect(() => callApplySort(['secret_token'])).toThrow(InvalidQueryException);
		});

		it('throws on descending concealed field', () => {
			expect(() => callApplySort(['-secret_token'])).toThrow(InvalidQueryException);
		});

		it('throws on function-wrapped concealed field', () => {
			expect(() => callApplySort(['year(secret_token)'])).toThrow(InvalidQueryException);
		});

		it('error message names the concealed field', () => {
			expect(() => callApplySort(['secret_token'])).toThrow(/secret_token/);
		});
	});

	describe('regression — non-concealed sort continues to work', () => {
		it('accepts a non-concealed field', () => {
			expect(() => callApplySort(['title'])).not.toThrow();
		});

		it('accepts descending non-concealed field', () => {
			expect(() => callApplySort(['-title'])).not.toThrow();
		});

		it('does not raise the conceal error for function-wrapped non-concealed fields', () => {
			expect(() => callApplySort(['year(title)'])).not.toThrow(/concealed/);
		});
	});

	describe('bug-exposing — relational sort by a concealed field on the related collection is rejected', () => {
		function callRelationalSort(sort: string[]) {
			const dbQuery = knex.default({ client: 'sqlite3', useNullAsDefault: true }).from('notes').select('*');

			const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });
			return applySort(knexInstance, makeRelationalSchema(), dbQuery, sort, 'notes', {});
		}

		it('throws InvalidQueryException for sort on a concealed field on the related collection', () => {
			expect(() => callRelationalSort(['author.tfa_secret'])).toThrow(InvalidQueryException);
		});

		it('error message names the concealed field', () => {
			expect(() => callRelationalSort(['author.tfa_secret'])).toThrow(/tfa_secret/);
		});

		it('accepts sort on a non-concealed field on the related collection (regression)', () => {
			expect(() => callRelationalSort(['author.name'])).not.toThrow(/concealed/);
		});
	});
});

describe('validateGroupOperands — concealed operand rejection', () => {
	describe('bug-exposing — concealed group operand raises InvalidQueryException', () => {
		it('throws on direct concealed field', () => {
			expect(() => validateGroupOperands(makeSchema(), 'notes', ['secret_token'])).toThrow(InvalidQueryException);
		});

		it('throws on function-wrapped concealed field', () => {
			expect(() => validateGroupOperands(makeSchema(), 'notes', ['year(secret_token)'])).toThrow(InvalidQueryException);
		});

		it('error message names the concealed field', () => {
			expect(() => validateGroupOperands(makeSchema(), 'notes', ['secret_token'])).toThrow(/secret_token/);
		});
	});

	describe('regression — non-concealed group continues to work', () => {
		it('accepts a non-concealed field', () => {
			expect(() => validateGroupOperands(makeSchema(), 'notes', ['title'])).not.toThrow();
		});

		it('accepts multiple non-concealed fields', () => {
			expect(() => validateGroupOperands(makeSchema(), 'notes', ['title', 'body'])).not.toThrow();
		});

		it('does not throw on empty group array', () => {
			expect(() => validateGroupOperands(makeSchema(), 'notes', [])).not.toThrow();
		});
	});
});

describe('applyAggregate primary key countDistinct optimization', () => {
	function runAggregateQuery(schema: SchemaOverview, query: Query) {
		const dbQuery = makeBuilder();
		const knexInstance = knex.default({ client: 'sqlite3', useNullAsDefault: true });

		applyQuery(knexInstance, 'notes', dbQuery, query, schema, { accountability: null });

		return dbQuery.toSQL().sql.toLowerCase();
	}

	it('emits a plain count for the primary key when the query adds no joins', () => {
		const sql = runAggregateQuery(makeSchema(), { aggregate: { countDistinct: ['id'] } });

		expect(sql).toContain('count(');
		expect(sql).not.toContain('count(distinct');
	});

	it('keeps countDistinct for the primary key when a relational filter adds a join', () => {
		const sql = runAggregateQuery(makeRelationalSchema(), {
			aggregate: { countDistinct: ['id'] },
			filter: { author: { name: { _eq: 'Rijk' } } },
		});

		expect(sql).toContain('count(distinct');
	});

	it('keeps countDistinct for the primary key when a relational sort adds a join', () => {
		const sql = runAggregateQuery(makeRelationalSchema(), {
			aggregate: { countDistinct: ['id'] },
			sort: ['author.name'],
		});

		expect(sql).toContain('count(distinct');
	});

	it('keeps countDistinct for non-primary-key fields without joins', () => {
		const sql = runAggregateQuery(makeSchema(), { aggregate: { countDistinct: ['title'] } });

		expect(sql).toContain('count(distinct');
	});

	it('still rejects value-deriving aggregates on concealed operands with a filter present', () => {
		expect(() =>
			runAggregateQuery(makeSchema(), { aggregate: { min: ['secret_token'] }, filter: { title: { _eq: 'x' } } })
		).toThrow(InvalidQueryException);
	});
});
