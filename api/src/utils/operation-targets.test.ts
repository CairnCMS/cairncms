import { ForbiddenException } from '@cairncms/exceptions';
import knexLib from 'knex';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { envOverrides, processAST, getAST } = vi.hoisted(() => ({
	envOverrides: {} as Record<string, unknown>,
	processAST: vi.fn(),
	getAST: vi.fn(async () => ({ type: 'root' })),
}));

vi.mock('../env.js', async (importOriginal) => {
	const actual = (await importOriginal()) as { default: Record<string, unknown> };

	return {
		...actual,
		default: new Proxy(actual.default, {
			get: (target, prop) =>
				typeof prop === 'string' && prop in envOverrides ? envOverrides[prop] : target[prop as string],
		}),
	};
});

vi.mock('../services/authorization.js', () => ({
	AuthorizationService: class {
		processAST = processAST;
	},
}));

vi.mock('./get-ast-from-query.js', () => ({ default: getAST }));

import {
	classifyStoredKey,
	classifyStoredQuery,
	classifyStoredQueryColumn,
	decodeQueryOption,
	readStoredTargets,
	requireFilterCondition,
	requireQuerySelection,
	resolveKeySelection,
} from './operation-targets.js';

describe('decodeQueryOption', () => {
	test('returns an empty query for a Query saved blank, without decoding it', () => {
		expect(decodeQueryOption('not json', 'none')).toEqual({});
	});

	test.each([undefined, null, '', '   ', '\n\t'])(
		'returns an empty query when a saved Query resolves to %j',
		(query) => {
			expect(decodeQueryOption(query, 'configured')).toEqual({});
		}
	);

	test.each([
		['{"limit": 2}', { limit: 2 }],
		[{ limit: 2 }, { limit: 2 }],
		['null', null],
	])('decodes %j as %j', (query, expected) => {
		expect(decodeQueryOption(query, 'configured')).toEqual(expected);
	});
});

describe('resolveKeySelection', () => {
	test.each([{ value: [] }, { value: [[]] }])('treats $value as an empty selection', ({ value }) => {
		expect(resolveKeySelection(value)).toEqual([]);
	});

	test.each([null, undefined, '', [null], [''], true, {}, NaN, Infinity, [true], [5, {}], [[true]], [[null]]])(
		'refuses %j with INVALID_PAYLOAD',
		(value) => {
			expect(() => resolveKeySelection(value)).toThrow(expect.objectContaining({ code: 'INVALID_PAYLOAD' }));
		}
	);

	test.each([
		[0, [0]],
		['5', ['5']],
		['1,2', ['1', '2']],
		[
			[5, ''],
			[5, ''],
		],
		[['undefined'], ['undefined']],
		[[[2, 3]], [[2, 3]]],
		[[[2, '']], [[2, '']]],
	])('keeps %j as %j', (value, expected) => {
		expect(resolveKeySelection(value)).toEqual(expected);
	});
});

describe('requireQuerySelection', () => {
	afterEach(() => {
		for (const key of Object.keys(envOverrides)) delete envOverrides[key];
	});

	test.each([{ search: 'paid' }, { limit: 2 }, { limit: '2' }, { limit: -1 }])(
		'accepts %j without a filter check',
		(query) => {
			expect(requireQuerySelection(query)).toEqual({ filterOnly: false });
		}
	);

	test('asks for a filter check when the filter is the only selector', () => {
		expect(requireQuerySelection({ filter: { status: { _eq: 'paid' } }, sort: ['id'] })).toEqual({ filterOnly: true });
	});

	test.each([{}, { foo: 1 }, { sort: ['id'] }, { filter: {} }, null, [], 'text'])(
		'refuses %j with INVALID_CONFIG',
		(query) => {
			expect(() => requireQuerySelection(query)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
		}
	);

	test.each([
		{ limit: 'abc' },
		{ limit: true },
		{ limit: '' },
		{ limit: 1.5 },
		{ limit: -2 },
		{ limit: 'abc', search: 'paid' },
		{ limit: 1.5, filter: { status: { _eq: 'paid' } } },
	])('refuses the invalid limit in %j with INVALID_QUERY', (query) => {
		expect(() => requireQuerySelection(query)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
	});

	test.each([{ limit: 20 }, { limit: 20, search: 'paid' }, { limit: 20, filter: { status: { _eq: 'paid' } } }])(
		'refuses %j over QUERY_LIMIT_MAX, whatever else selects',
		(query) => {
			envOverrides['QUERY_LIMIT_MAX'] = 10;
			expect(() => requireQuerySelection(query)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
		}
	);

	test.each([{ limit: 10 }, { limit: 10, search: 'paid' }, { limit: 10, filter: { status: { _eq: 'paid' } } }])(
		'accepts %j at QUERY_LIMIT_MAX',
		(query) => {
			envOverrides['QUERY_LIMIT_MAX'] = 10;
			expect(requireQuerySelection(query)).toEqual({ filterOnly: false });
		}
	);
});

describe('requireFilterCondition', () => {
	const field = (name: string, type: string) => ({
		field: name,
		type,
		dbType: type,
		nullable: true,
		special: [],
		defaultValue: null,
		precision: null,
		scale: null,
		generated: false,
		note: null,
		alias: false,
		validation: null,
	});

	const schema = {
		collections: {
			orders: {
				collection: 'orders',
				primary: 'id',
				singleton: false,
				note: null,
				sortField: null,
				accountability: 'all',
				fields: { id: field('id', 'integer'), status: field('status', 'string'), price: field('price', 'integer') },
			},
		},
		relations: [],
	} as any;

	const knex = knexLib({ client: 'pg' });
	const admin = { admin: true, role: null, user: null } as any;
	const member = { admin: false, role: 'r-1', user: 'u-1' } as any;

	beforeEach(() => {
		processAST.mockReset();
		getAST.mockClear();
	});

	test.each([{ _and: [] }, { _or: [{}] }, { price: { _between: [10] } }])(
		'refuses %j, which the builder drops, with INVALID_CONFIG',
		async (filter) => {
			await expect(
				requireFilterCondition('orders', filter as any, { schema, accountability: admin, knex })
			).rejects.toMatchObject({
				code: 'INVALID_CONFIG',
			});
		}
	);

	test.each([
		{ price: { _between: [10, 20] } },
		{ _or: [{ status: { _eq: 'open' } }, { _and: [] }] },
		{ id: { _in: [] } },
		{ id: { _nin: [] } },
	])('accepts %j, which the builder turns into a condition', async (filter) => {
		await expect(
			requireFilterCondition('orders', filter as any, { schema, accountability: admin, knex })
		).resolves.toBeUndefined();
	});

	test('skips the permission step for an admin identity', async () => {
		await requireFilterCondition('orders', { status: { _eq: 'open' } } as any, { schema, accountability: admin, knex });
		expect(getAST).not.toHaveBeenCalled();
	});

	test('checks field permissions before compiling for an identity that is not an admin', async () => {
		processAST.mockRejectedValue(new ForbiddenException());

		await expect(
			requireFilterCondition('orders', { missing: { _eq: 1 } } as any, { schema, accountability: member, knex })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		expect(getAST).toHaveBeenCalledOnce();
	});

	test('fails with the builder error when compiling throws', async () => {
		await expect(
			requireFilterCondition('orders', { missing: { _eq: 1 } } as any, { schema, accountability: admin, knex })
		).rejects.toMatchObject({ code: 'INVALID_QUERY' });
	});

	test('leaves an unknown collection for the items service to report', async () => {
		await expect(
			requireFilterCondition('unknown', { status: { _eq: 'open' } } as any, { schema, accountability: admin, knex })
		).resolves.toBeUndefined();
	});
});

describe('classifyStoredKey', () => {
	test.each([undefined, null, '', []])('treats %j as no key', (value) => {
		expect(classifyStoredKey(value)).toBe('none');
	});

	test.each([0, 5, '5', '1,2', '{{ $trigger.body.id }}', ['{{ $trigger.body.id }}'], [0], ['5', '6']])(
		'treats %j as a configured key',
		(value) => {
			expect(classifyStoredKey(value)).toBe('configured');
		}
	);

	test.each([{}, { id: 5 }, true, false])('treats %j as a malformed key', (value) => {
		expect(classifyStoredKey(value)).toBe('malformed');
	});
});

describe('classifyStoredQuery', () => {
	test.each([undefined, null, '', '   ', {}, '{}', ' { } ', '\n{\t}\r\n'])('treats %j as no query', (value) => {
		expect(classifyStoredQuery(value)).toBe('none');
	});

	test.each([
		{ filter: { status: { _eq: 'paid' } } },
		{ limit: 2 },
		'{"limit": 2}',
		'{{ $trigger.body.query }}',
		'not json',
	])('treats %j as a configured query', (value) => {
		expect(classifyStoredQuery(value)).toBe('configured');
	});

	test('treats a query whose only member is __proto__ as configured, in text and object form', () => {
		const text = '{"__proto__": {"filter": {"paid": {"_eq": true}}}}';

		expect(classifyStoredQuery(text)).toBe('configured');
		expect(classifyStoredQuery(JSON.parse(text))).toBe('configured');
	});
});

describe('classifyStoredQueryColumn', () => {
	const protoOnly = '{"key": [5], "query": {"__proto__": {"filter": {"paid": {"_eq": true}}}}}';

	test('keeps a query whose only member is __proto__ configured in a text column', () => {
		expect(classifyStoredQueryColumn(protoOnly)).toBe('configured');
	});

	test('keeps a query whose only member is __proto__ configured in a parsed column', () => {
		expect(classifyStoredQueryColumn(JSON.parse(protoOnly))).toBe('configured');
	});

	test.each([
		'{"key": [5]}',
		'{"key": [5], "query": {}}',
		'{"key": [5], "query": "{ }"}',
		'{"__proto__": {"query": {"limit": 2}}}',
		'not json',
		null,
	])('treats %j as having no saved query', (column) => {
		expect(classifyStoredQueryColumn(column)).toBe('none');
	});

	test('reads a query saved as text inside the column', () => {
		expect(classifyStoredQueryColumn('{"query": "{\\"limit\\": 2}"}')).toBe('configured');
	});
});

describe('readStoredTargets', () => {
	test.each(['item-update', 'item-delete'])(
		'%s refuses a key when the raw column saved a query that sanitizing removed',
		(type) => {
			expect(() => readStoredTargets(type, { key: [5], query: {} }, 'configured')).toThrow(
				expect.objectContaining({ code: 'INVALID_CONFIG' })
			);
		}
	);

	test.each(['item-read', 'item-update', 'item-delete'])('%s refuses a malformed key', (type) => {
		expect(() => readStoredTargets(type, { key: { id: 5 } })).toThrow(
			expect.objectContaining({ code: 'INVALID_CONFIG' })
		);
	});

	test.each(['item-update', 'item-delete'])('%s refuses a key saved with a query', (type) => {
		expect(() =>
			readStoredTargets(type, { key: ['{{ $trigger.body.ids }}'], query: '{{ $trigger.body.query }}' })
		).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
	});

	test.each(['item-update', 'item-delete'])(
		'%s refuses a key saved with a query whose only member is __proto__',
		(type) => {
			const text = '{"__proto__": {"filter": {"paid": {"_eq": true}}}}';

			for (const query of [text, JSON.parse(text)]) {
				expect(() => readStoredTargets(type, { key: [5], query })).toThrow(
					expect.objectContaining({ code: 'INVALID_CONFIG' })
				);
			}
		}
	);

	test('item-read accepts a key saved with a query', () => {
		expect(readStoredTargets('item-read', { key: [5], query: { fields: ['name'] } })).toEqual({
			key: 'configured',
			query: 'configured',
		});
	});

	test.each(['item-update', 'item-delete'])('%s accepts a key with an empty saved query', (type) => {
		expect(readStoredTargets(type, { key: [5], query: '{}' })).toEqual({ key: 'configured', query: 'none' });
	});

	test('reads a step with neither as no key and no query', () => {
		expect(readStoredTargets('item-delete', {})).toEqual({ key: 'none', query: 'none' });
		expect(readStoredTargets('item-delete', null)).toEqual({ key: 'none', query: 'none' });
	});
});
