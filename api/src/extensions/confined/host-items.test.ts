import type { Accountability, Query } from '@cairncms/types';
import { describe, expect, it, vi } from 'vitest';
import {
	createConfinedItemsHost,
	ITEMS_MAX_LIMIT,
	ITEMS_MAX_OFFSET,
	normalizeItemsQuery,
	type ConfinedItemsHostDeps,
	type ConfinedItemsReader,
} from './host-items.js';
import { ITEMS_REPLY_BYTES } from './sandbox-limits.js';

const liveSignal = new AbortController().signal;

const user: Accountability = { user: 'user-1', role: 'role-1', admin: false };

class SeamForbidden extends Error {
	code = 'FORBIDDEN';
}

function makeHost(overrides: Partial<ConfinedItemsHostDeps> = {}) {
	const calls: Array<{ collection: string; accountability: Accountability | null }> = [];
	const queries: Query[] = [];
	const keys: Array<string | number> = [];

	const reader: ConfinedItemsReader = {
		readByQuery: vi.fn(async (query: Query) => {
			queries.push(query);
			return [{ id: 1 }];
		}),
		readOne: vi.fn(async (key: string | number, query: Query) => {
			keys.push(key);
			queries.push(query);
			return { id: key };
		}),
	};

	const deps: ConfinedItemsHostDeps = {
		capabilities: { items: 'current-user' },
		accountability: user,
		itemsService: (collection, accountability) => {
			calls.push({ collection, accountability });
			return reader;
		},
		itemsReplyBytes: ITEMS_REPLY_BYTES,
		...overrides,
	};

	return { host: createConfinedItemsHost(deps), calls, queries, keys, reader };
}

describe('normalizeItemsQuery', () => {
	it('returns an explicit clamped limit for an absent query', () => {
		const result = normalizeItemsQuery(undefined);
		expect(result).toEqual({ ok: true, query: { limit: ITEMS_MAX_LIMIT } });
	});

	it('builds a new object carrying only the supported keys', () => {
		const result = normalizeItemsQuery({
			fields: ['id', 'title', 'author.name'],
			filter: { status: { _eq: 'published' } },
			sort: ['-date_created', 'title'],
			limit: 10,
			offset: 5,
			page: 2,
			search: 'hello',
		});

		expect(result).toEqual({
			ok: true,
			query: {
				fields: ['id', 'title', 'author.name'],
				filter: { status: { _eq: 'published' } },
				sort: ['-date_created', 'title'],
				limit: 10,
				offset: 5,
				page: 2,
				search: 'hello',
			},
		});
	});

	it('refuses every unsupported platform query key', () => {
		for (const key of ['deep', 'alias', 'aggregate', 'groupBy', 'export', 'anythingElse']) {
			const result = normalizeItemsQuery({ [key]: {} });
			expect(result.ok, key).toBe(false);
			if (!result.ok) expect(result.reason).toContain(key);
		}
	});

	it('rejects -1 and non-positive limits and clamps an over-max limit', () => {
		expect(normalizeItemsQuery({ limit: -1 }).ok).toBe(false);
		expect(normalizeItemsQuery({ limit: 0 }).ok).toBe(false);
		expect(normalizeItemsQuery({ limit: 1.5 }).ok).toBe(false);
		expect(normalizeItemsQuery({ limit: '10' }).ok).toBe(false);

		const clamped = normalizeItemsQuery({ limit: ITEMS_MAX_LIMIT * 10 });
		expect(clamped).toEqual({ ok: true, query: { limit: ITEMS_MAX_LIMIT } });
	});

	it('rejects deep wildcard field expansions while allowing the plain wildcard', () => {
		expect(normalizeItemsQuery({ fields: ['*'] }).ok).toBe(true);
		expect(normalizeItemsQuery({ fields: ['*.*'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: ['author.*'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: ['*.author'] }).ok).toBe(false);
	});

	it('rejects malformed and oversized field shapes', () => {
		expect(normalizeItemsQuery({ fields: 'id' }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: [7] }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: [''] }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: ['a.b.c.d'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: ['year(date_created)'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ fields: Array.from({ length: 65 }, (_, i) => `f${i}`) }).ok).toBe(false);
	});

	it('rejects malformed sort shapes', () => {
		expect(normalizeItemsQuery({ sort: '-id' }).ok).toBe(false);
		expect(normalizeItemsQuery({ sort: ['*'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ sort: ['-'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ sort: ['a;drop'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ sort: ['a.b.c.d'] }).ok).toBe(false);
		expect(normalizeItemsQuery({ sort: Array.from({ length: 9 }, (_, i) => `f${i}`) }).ok).toBe(false);
	});

	it('rejects negative offsets and pages and unbounded search', () => {
		expect(normalizeItemsQuery({ offset: -1 }).ok).toBe(false);
		expect(normalizeItemsQuery({ page: -1 }).ok).toBe(false);
		expect(normalizeItemsQuery({ search: 'x'.repeat(257) }).ok).toBe(false);
		expect(normalizeItemsQuery({ search: 7 }).ok).toBe(false);
	});

	it('rejects an over-deep filter, an oversized filter, and non-plain filter values', () => {
		let nested: Record<string, unknown> = { status: { _eq: 'ok' } };
		for (let i = 0; i < 10; i++) nested = { _and: [nested] };
		expect(normalizeItemsQuery({ filter: nested }).ok).toBe(false);

		const wide: Record<string, unknown> = {};
		for (let i = 0; i < 300; i++) wide[`f${i}`] = { _eq: i };
		expect(normalizeItemsQuery({ filter: wide }).ok).toBe(false);

		expect(normalizeItemsQuery({ filter: { when: new Date() } }).ok).toBe(false);
		expect(normalizeItemsQuery({ filter: [] }).ok).toBe(false);
		expect(normalizeItemsQuery({ filter: 'status' }).ok).toBe(false);
	});

	it('accepts the supported filter grammar', () => {
		for (const filter of [
			{ status: { _eq: 'published' } },
			{ author: { name: { _icontains: 'smith' } } },
			{ _or: [{ status: { _eq: 'a' } }, { status: { _eq: 'b' } }] },
			{ _and: [{ author: { name: { _eq: 'x' } } }, { author: { role: { _neq: 'y' } } }] },
			{ status: { _eq: 'a' }, featured: { _eq: true } },
			{ id: { _in: [1, 2, 3] } },
			{ date_created: { _between: ['2026-01-01', '2026-12-31'] } },
			{ parent: { _null: true } },
			{},
		]) {
			const result = normalizeItemsQuery({ filter });
			expect(result.ok, JSON.stringify(filter)).toBe(true);
			if (result.ok) expect(result.query.filter).toEqual(filter);
		}
	});

	it('refuses a known operator outside a field value object', () => {
		for (const filter of [{ _eq: 'x' }, { _and: [{ _eq: 'x' }] }]) {
			const result = normalizeItemsQuery({ filter });
			expect(result.ok, JSON.stringify(filter)).toBe(false);
			if (!result.ok) expect(result.reason).toBe('a filter operator must apply to a field');
		}
	});

	it('refuses field filters the platform path derivation would misapply', () => {
		// The platform follows only the first child under a field, so sibling
		// predicates and sibling operators are silently dropped, a field-scoped
		// logical degenerates into an equality, and an empty field value crashes
		// the path derivation.
		for (const [filter, label] of [
			[{ status: {} }, 'empty field value'],
			[{ author: { name: { _eq: 'x' }, role: { _neq: 'y' } } }, 'sibling fields under one field'],
			[{ status: { _eq: 'a', _neq: 'b' } }, 'sibling operators under one field'],
			[{ author: { _and: [{ name: { _eq: 'x' } }] } }, 'field-scoped logical'],
			[{ author: { _or: [{ _eq: 1 }] } }, 'field-scoped logical with bare operator'],
		] as const) {
			expect(normalizeItemsQuery({ filter }).ok, label).toBe(false);
		}
	});

	it('refuses filter keys outside the field segment grammar', () => {
		for (const key of ['year(date_created)', '$FOLLOW(articles, author)', 'author.name', 'a b', 'a;drop']) {
			const result = normalizeItemsQuery({ filter: { [key]: { _eq: 1 } } });
			expect(result.ok, key).toBe(false);
		}
	});

	it('refuses unknown operators by name and malformed operator values', () => {
		const unknown = normalizeItemsQuery({ filter: { status: { _regex: '.*' } } });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.reason).toContain('_regex');

		expect(normalizeItemsQuery({ filter: { id: { _eq: { nested: 1 } } } }).ok).toBe(false);
		expect(normalizeItemsQuery({ filter: { id: { _in: [{ id: 1 }] } } }).ok).toBe(false);
		expect(normalizeItemsQuery({ filter: { id: { _in: Array.from({ length: 101 }, (_, i) => i) } } }).ok).toBe(false);
	});

	it('refuses operator values outside each operator value shape', () => {
		// The range arity case is the silent-broadening one: the platform applies
		// no predicate at all for a range whose length is not exactly two.
		for (const [filter, label] of [
			[{ price: { _between: [1, 2, 3] } }, 'range arity'],
			[{ price: { _between: [1] } }, 'range arity short'],
			[{ price: { _between: 'ab' } }, 'range string'],
			[{ price: { _between: [1, true] } }, 'range boolean entry'],
			[{ id: { _in: 5 } }, 'list scalar'],
			[{ id: { _in: [] } }, 'list empty'],
			[{ id: { _in: [true] } }, 'list boolean entry'],
			[{ title: { _icontains: 7 } }, 'string operator number'],
			[{ title: { _starts_with: null } }, 'string operator null'],
			[{ parent: { _null: 'yes' } }, 'presence string'],
			[{ parent: { _nempty: 1 } }, 'presence number'],
			[{ price: { _lt: true } }, 'comparison boolean'],
			[{ price: { _gte: null } }, 'comparison null'],
			[{ status: { _eq: null } }, 'equality null'],
		] as const) {
			expect(normalizeItemsQuery({ filter }).ok, label).toBe(false);
		}

		expect(normalizeItemsQuery({ filter: { status: { _eq: true } } }).ok).toBe(true);
	});

	it('refuses operators outside the platform validator vocabulary', () => {
		for (const operator of [
			'_ieq',
			'_nieq',
			'_nicontains',
			'_istarts_with',
			'_nistarts_with',
			'_iends_with',
			'_niends_with',
		]) {
			const result = normalizeItemsQuery({ filter: { status: { [operator]: 'x' } } });
			expect(result.ok, operator).toBe(false);
			if (!result.ok) expect(result.reason).toContain(operator);
		}
	});

	it('refuses the equality shorthand in favor of explicit operators', () => {
		expect(normalizeItemsQuery({ filter: { status: 'published' } }).ok).toBe(false);
	});

	it('refuses malformed logical groups', () => {
		expect(normalizeItemsQuery({ filter: { _and: { status: { _eq: 'x' } } } }).ok).toBe(false);
		expect(normalizeItemsQuery({ filter: { _and: [] } }).ok).toBe(false);
		expect(normalizeItemsQuery({ filter: { _and: [{}] } }).ok).toBe(false);

		const branches = Array.from({ length: 17 }, (_, i) => ({ id: { _eq: i } }));
		expect(normalizeItemsQuery({ filter: { _or: branches } }).ok).toBe(false);
	});

	it('refuses an offset or page beyond the seek maximum', () => {
		expect(normalizeItemsQuery({ offset: ITEMS_MAX_OFFSET })).toEqual({
			ok: true,
			query: { limit: ITEMS_MAX_LIMIT, offset: ITEMS_MAX_OFFSET },
		});

		expect(normalizeItemsQuery({ offset: ITEMS_MAX_OFFSET + 1 }).ok).toBe(false);
		expect(normalizeItemsQuery({ offset: Number.MAX_SAFE_INTEGER }).ok).toBe(false);

		// The implied offset is page minus one times the effective limit.
		expect(normalizeItemsQuery({ page: 101 }).ok).toBe(true);
		expect(normalizeItemsQuery({ page: 102 }).ok).toBe(false);
		expect(normalizeItemsQuery({ page: 10_001, limit: 1 }).ok).toBe(true);
		expect(normalizeItemsQuery({ page: 10_002, limit: 1 }).ok).toBe(false);
		expect(normalizeItemsQuery({ page: Number.MAX_SAFE_INTEGER }).ok).toBe(false);
	});
});

describe('createConfinedItemsHost authority', () => {
	it('denies without the items capability and never constructs the service', async () => {
		const { host, calls } = makeHost({ capabilities: {} });

		for (const reply of [
			await host.read({ collection: 'articles' }, liveSignal),
			await host.readOne({ collection: 'articles', key: 1 }, liveSignal),
		]) {
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('denies current-user with a null or missing accountability', async () => {
		for (const accountability of [null, undefined]) {
			const { host, calls } = makeHost({ accountability });
			const reply = await host.read({ collection: 'articles' }, liveSignal);

			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
			expect(calls).toHaveLength(0);
		}
	});

	it('passes the exact invocation accountability to the factory under current-user', async () => {
		const { host, calls } = makeHost();
		await host.read({ collection: 'articles' }, liveSignal);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.collection).toBe('articles');
		expect(calls[0]?.accountability).toBe(user);
	});

	it('passes the system context only under the declared system mode', async () => {
		const { host, calls } = makeHost({ capabilities: { items: 'system' }, accountability: user });
		await host.read({ collection: 'articles' }, liveSignal);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.accountability).toBeNull();
	});

	it('denies when no items service is wired', async () => {
		const { host } = makeHost({ itemsService: undefined });
		const reply = await host.read({ collection: 'articles' }, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
	});
});

describe('createConfinedItemsHost read', () => {
	it('marshals results as JSON values', async () => {
		const { host } = makeHost();
		const reply = await host.read({ collection: 'articles' }, liveSignal);
		expect(reply).toEqual({ ok: true, value: [{ id: 1 }] });
	});

	it('clamps an over-max limit before the service runs and always sends an explicit limit', async () => {
		const { host, queries } = makeHost();

		await host.read({ collection: 'articles', query: { limit: 10_000 } }, liveSignal);
		await host.read({ collection: 'articles' }, liveSignal);

		expect(queries[0]?.limit).toBe(ITEMS_MAX_LIMIT);
		expect(queries[1]?.limit).toBe(ITEMS_MAX_LIMIT);
	});

	it('refuses each unsupported query key without reaching the service', async () => {
		const { host, calls } = makeHost();

		for (const key of ['deep', 'alias', 'aggregate', 'groupBy', 'export', 'anythingElse']) {
			const reply = await host.read({ collection: 'articles', query: { [key]: {} } }, liveSignal);
			expect(reply, key).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('refuses unsupported filter constructs and over-max seeks without reaching the service', async () => {
		const { host, calls } = makeHost();

		for (const query of [
			{ filter: { 'year(date_created)': { _eq: 2026 } } },
			{ filter: { status: { _regex: '.*' } } },
			{ filter: { _eq: 'misplaced' } },
			{ filter: { price: { _between: [1, 2, 3] } } },
			{ filter: { author: { name: { _eq: 'x' }, role: { _neq: 'y' } } } },
			{ filter: { status: {} } },
			{ offset: ITEMS_MAX_OFFSET + 1 },
			{ page: Number.MAX_SAFE_INTEGER },
		]) {
			const reply = await host.read({ collection: 'articles', query }, liveSignal);
			expect(reply, JSON.stringify(query)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('rejects a malformed collection', async () => {
		const { host, calls } = makeHost();

		for (const collection of [undefined, '', 7, 'x'.repeat(256)]) {
			const reply = await host.read({ collection }, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('maps a forbidden read to a sanitized denial', async () => {
		const reader: ConfinedItemsReader = {
			readByQuery: async () => {
				throw new SeamForbidden();
			},
			readOne: async () => null,
		};

		const { host } = makeHost({ itemsService: () => reader });
		const reply = await host.read({ collection: 'articles' }, liveSignal);

		expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the read was denied' } });
	});

	it('maps a thrown service to a sanitized internal error', async () => {
		const reader: ConfinedItemsReader = {
			readByQuery: async () => {
				throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
			},
			readOne: async () => null,
		};

		const { host } = makeHost({ itemsService: () => reader });
		const reply = await host.read({ collection: 'articles' }, liveSignal);

		expect(reply).toEqual({ ok: false, error: { code: 'internal', message: 'the items read failed' } });
		expect(JSON.stringify(reply)).not.toContain('ECONNREFUSED');
	});

	it('refuses an over-cap reply at the surface', async () => {
		const reader: ConfinedItemsReader = {
			readByQuery: async () => [{ blob: 'x'.repeat(ITEMS_REPLY_BYTES) }],
			readOne: async () => null,
		};

		const { host } = makeHost({ itemsService: () => reader });
		const reply = await host.read({ collection: 'articles' }, liveSignal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('settles with a timeout when the service ignores the abort signal', async () => {
		const controller = new AbortController();

		const reader: ConfinedItemsReader = {
			readByQuery: () => new Promise(() => undefined),
			readOne: async () => null,
		};

		const { host } = makeHost({ itemsService: () => reader });
		const pending = host.read({ collection: 'articles' }, controller.signal);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});
});

describe('createConfinedItemsHost readOne', () => {
	it('marshals a found item and passes the key through', async () => {
		const { host, keys } = makeHost();
		const reply = await host.readOne({ collection: 'articles', key: 42, query: { fields: ['id'] } }, liveSignal);

		expect(reply).toEqual({ ok: true, value: { id: 42 } });
		expect(keys).toEqual([42]);
	});

	it('rejects malformed keys', async () => {
		const { host, calls } = makeHost();

		for (const key of [undefined, '', 1.5, { id: 1 }, [1], true, 'x'.repeat(256)]) {
			const reply = await host.readOne({ collection: 'articles', key }, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('collapses forbidden and missing to the same null', async () => {
		const reader: ConfinedItemsReader = {
			readByQuery: async () => [],
			readOne: async () => {
				throw new SeamForbidden();
			},
		};

		const { host } = makeHost({ itemsService: () => reader });
		const reply = await host.readOne({ collection: 'articles', key: 'missing-or-forbidden' }, liveSignal);

		expect(reply).toEqual({ ok: true, value: null });
	});
});
