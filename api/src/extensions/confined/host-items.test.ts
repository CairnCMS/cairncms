import type { Accountability, Query } from '@cairncms/types';
import { describe, expect, it, vi } from 'vitest';
import type { Item, PrimaryKey } from '../../types/items.js';
import {
	CONFINED_WRITE_MAX_BYTES,
	CONFINED_WRITE_MAX_DEPTH,
	createConfinedItemsHost,
	ITEMS_MAX_LIMIT,
	ITEMS_MAX_OFFSET,
	normalizeItemsQuery,
	type ConfinedItemsHost,
	type ConfinedItemsHostDeps,
	type ConfinedItemsReader,
	type ConfinedItemsWriter,
} from './host-items.js';
import { ITEMS_REPLY_BYTES } from './sandbox-limits.js';
import type { ConfinedHostReply } from './types.js';

const liveSignal = new AbortController().signal;

const user: Accountability = { user: 'user-1', role: 'role-1', admin: false };

class SeamForbidden extends Error {
	code = 'FORBIDDEN';
}

type ConfinedItemsService = ConfinedItemsReader & ConfinedItemsWriter;

function serviceStub(overrides: Partial<ConfinedItemsService> = {}): ConfinedItemsService {
	return {
		readByQuery: async () => [],
		readOne: async () => null,
		createOne: async () => 1,
		createMany: async () => [1],
		updateOne: async () => 1,
		updateMany: async () => [1],
		deleteOne: async () => 1,
		deleteMany: async () => [1],
		...overrides,
	};
}

type WriteCall = { method: string; args: unknown[] };

function makeHost(overrides: Partial<ConfinedItemsHostDeps> = {}) {
	const calls: Array<{ collection: string; accountability: Accountability | null }> = [];
	const queries: Query[] = [];
	const keys: Array<string | number> = [];
	const writes: WriteCall[] = [];

	const record =
		(method: string) =>
		(...args: unknown[]) => {
			writes.push({ method, args });
		};

	const service: ConfinedItemsService = {
		readByQuery: vi.fn(async (query: Query) => {
			queries.push(query);
			return [{ id: 1 }];
		}),
		readOne: vi.fn(async (key: string | number, query: Query) => {
			keys.push(key);
			queries.push(query);
			return { id: key };
		}),
		createOne: vi.fn(async (payload: Partial<Item>) => {
			record('createOne')(payload);
			return 'created-1';
		}),
		createMany: vi.fn(async (payloads: Partial<Item>[]) => {
			record('createMany')(payloads);
			return payloads.map((_, index) => `created-${index + 1}`);
		}),
		updateOne: vi.fn(async (key: PrimaryKey, payload: Partial<Item>) => {
			record('updateOne')(key, payload);
			return key;
		}),
		updateMany: vi.fn(async (keys: PrimaryKey[], payload: Partial<Item>) => {
			record('updateMany')(keys, payload);
			return keys;
		}),
		deleteOne: vi.fn(async (key: PrimaryKey) => {
			record('deleteOne')(key);
			return key;
		}),
		deleteMany: vi.fn(async (keys: PrimaryKey[]) => {
			record('deleteMany')(keys);
			return keys;
		}),
	};

	const deps: ConfinedItemsHostDeps = {
		capabilities: { items: { accountability: 'user' } },
		accountability: user,
		itemsService: (collection, accountability) => {
			calls.push({ collection, accountability });
			return service;
		},
		itemsReplyBytes: ITEMS_REPLY_BYTES,
		...overrides,
	};

	return { host: createConfinedItemsHost(deps), calls, queries, keys, writes, service };
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
			await host.readMany({ collection: 'articles' }, liveSignal),
			await host.readOne({ collection: 'articles', key: 1 }, liveSignal),
		]) {
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('denies user with a null or missing accountability', async () => {
		for (const accountability of [null, undefined]) {
			const { host, calls } = makeHost({ accountability });
			const reply = await host.readMany({ collection: 'articles' }, liveSignal);

			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
			expect(calls).toHaveLength(0);
		}
	});

	it('passes the exact invocation accountability to the factory under user', async () => {
		const { host, calls } = makeHost();
		await host.readMany({ collection: 'articles' }, liveSignal);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.collection).toBe('articles');
		expect(calls[0]?.accountability).toBe(user);
	});

	it('passes the system context only under the declared full-access mode', async () => {
		const { host, calls } = makeHost({
			capabilities: { items: { accountability: 'full-access' } },
			accountability: user,
		});

		await host.readMany({ collection: 'articles' }, liveSignal);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.accountability).toBeNull();
	});

	it('denies when no items service is wired', async () => {
		const { host } = makeHost({ itemsService: undefined });
		const reply = await host.readMany({ collection: 'articles' }, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
	});
});

describe('createConfinedItemsHost readMany', () => {
	it('marshals results as JSON values', async () => {
		const { host } = makeHost();
		const reply = await host.readMany({ collection: 'articles' }, liveSignal);
		expect(reply).toEqual({ ok: true, value: [{ id: 1 }] });
	});

	it('clamps an over-max limit before the service runs and always sends an explicit limit', async () => {
		const { host, queries } = makeHost();

		await host.readMany({ collection: 'articles', query: { limit: 10_000 } }, liveSignal);
		await host.readMany({ collection: 'articles' }, liveSignal);

		expect(queries[0]?.limit).toBe(ITEMS_MAX_LIMIT);
		expect(queries[1]?.limit).toBe(ITEMS_MAX_LIMIT);
	});

	it('refuses each unsupported query key without reaching the service', async () => {
		const { host, calls } = makeHost();

		for (const key of ['deep', 'alias', 'aggregate', 'groupBy', 'export', 'anythingElse']) {
			const reply = await host.readMany({ collection: 'articles', query: { [key]: {} } }, liveSignal);
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
			const reply = await host.readMany({ collection: 'articles', query }, liveSignal);
			expect(reply, JSON.stringify(query)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('rejects a malformed collection', async () => {
		const { host, calls } = makeHost();

		for (const collection of [undefined, '', 7, 'x'.repeat(256)]) {
			const reply = await host.readMany({ collection }, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('maps a forbidden read to a sanitized denial', async () => {
		const service = serviceStub({
			readByQuery: async () => {
				throw new SeamForbidden();
			},
		});

		const { host } = makeHost({ itemsService: () => service });
		const reply = await host.readMany({ collection: 'articles' }, liveSignal);

		expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the read was denied' } });
	});

	it('maps a thrown service to a sanitized internal error', async () => {
		const service = serviceStub({
			readByQuery: async () => {
				throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
			},
		});

		const { host } = makeHost({ itemsService: () => service });
		const reply = await host.readMany({ collection: 'articles' }, liveSignal);

		expect(reply).toEqual({ ok: false, error: { code: 'internal', message: 'the items read failed' } });
		expect(JSON.stringify(reply)).not.toContain('ECONNREFUSED');
	});

	it('refuses an over-cap reply at the surface', async () => {
		const service = serviceStub({
			readByQuery: async () => [{ blob: 'x'.repeat(ITEMS_REPLY_BYTES) }],
		});

		const { host } = makeHost({ itemsService: () => service });
		const reply = await host.readMany({ collection: 'articles' }, liveSignal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('settles with a timeout when the service ignores the abort signal', async () => {
		const controller = new AbortController();

		const service = serviceStub({
			readByQuery: () => new Promise(() => undefined),
		});

		const { host } = makeHost({ itemsService: () => service });
		const pending = host.readMany({ collection: 'articles' }, controller.signal);
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
		const service = serviceStub({
			readOne: async () => {
				throw new SeamForbidden();
			},
		});

		const { host } = makeHost({ itemsService: () => service });
		const reply = await host.readOne({ collection: 'articles', key: 'missing-or-forbidden' }, liveSignal);

		expect(reply).toEqual({ ok: true, value: null });
	});
});

class SeamFailedValidation extends Error {
	code = 'FAILED_VALIDATION';

	constructor() {
		super('Value for field "email" is invalid');
	}
}

class SeamInvalidPayload extends Error {
	code = 'INVALID_PAYLOAD';

	constructor() {
		super('Exceeded max batch mutation limit of 500.');
	}
}

const writeInvocations = [
	{
		verb: 'createOne',
		invoke: (host) => host.createOne({ collection: 'articles', payload: { title: 'x' } }, liveSignal),
		forwarded: [{ title: 'x' }],
		value: 'created-1',
	},
	{
		verb: 'createMany',
		invoke: (host) => host.createMany({ collection: 'articles', payloads: [{ a: 1 }, { a: 2 }] }, liveSignal),
		forwarded: [[{ a: 1 }, { a: 2 }]],
		value: ['created-1', 'created-2'],
	},
	{
		verb: 'updateOne',
		invoke: (host) => host.updateOne({ collection: 'articles', key: 7, payload: { a: 1 } }, liveSignal),
		forwarded: [7, { a: 1 }],
		value: 7,
	},
	{
		verb: 'updateMany',
		invoke: (host) => host.updateMany({ collection: 'articles', keys: [7, 8], payload: { a: 1 } }, liveSignal),
		forwarded: [[7, 8], { a: 1 }],
		value: [7, 8],
	},
	{
		verb: 'deleteOne',
		invoke: (host) => host.deleteOne({ collection: 'articles', key: 7 }, liveSignal),
		forwarded: [7],
		value: 7,
	},
	{
		verb: 'deleteMany',
		invoke: (host) => host.deleteMany({ collection: 'articles', keys: [7, 8] }, liveSignal),
		forwarded: [[7, 8]],
		value: [7, 8],
	},
] satisfies Array<{
	verb: string;
	invoke: (host: ConfinedItemsHost) => Promise<ConfinedHostReply>;
	forwarded: unknown[];
	value: unknown;
}>;

function allWritesThrow(error: () => Error): ConfinedItemsService {
	return serviceStub({
		createOne: async () => {
			throw error();
		},
		createMany: async () => {
			throw error();
		},
		updateOne: async () => {
			throw error();
		},
		updateMany: async () => {
			throw error();
		},
		deleteOne: async () => {
			throw error();
		},
		deleteMany: async () => {
			throw error();
		},
	});
}

describe('createConfinedItemsHost writes', () => {
	it('dispatches each verb to the service and shapes its result', async () => {
		for (const testCase of writeInvocations) {
			const { host, calls, writes } = makeHost();

			const reply = await testCase.invoke(host);

			expect(reply, testCase.verb).toEqual({ ok: true, value: testCase.value });
			expect(writes, testCase.verb).toEqual([{ method: testCase.verb, args: testCase.forwarded }]);
			expect(calls[0]?.accountability, testCase.verb).toBe(user);
		}
	});

	it('applies the shared authority resolution to writes', async () => {
		const undeclared = makeHost({ capabilities: {} });
		const undeclaredReply = await undeclared.host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);
		expect(undeclaredReply).toMatchObject({ ok: false, error: { code: 'denied' } });
		expect(undeclared.calls).toHaveLength(0);
		expect(undeclared.writes).toHaveLength(0);

		for (const accountability of [null, undefined]) {
			const { host, calls } = makeHost({ accountability });
			const reply = await host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
			expect(calls).toHaveLength(0);
		}

		const anonymous: Accountability = { user: null, role: null, admin: false };
		const publicHost = makeHost({ accountability: anonymous });
		const publicReply = await publicHost.host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);
		expect(publicReply).toEqual({ ok: true, value: 'created-1' });
		expect(publicHost.calls[0]?.accountability).toBe(anonymous);

		const elevated = makeHost({ capabilities: { items: { accountability: 'full-access' } } });
		await elevated.host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);
		expect(elevated.calls[0]?.accountability).toBeNull();
	});

	it('refuses a malformed collection on writes before constructing the service', async () => {
		const { host, calls } = makeHost();

		for (const collection of [undefined, '', 7, 'x'.repeat(256)]) {
			const create = await host.createOne({ collection, payload: { a: 1 } }, liveSignal);
			const remove = await host.deleteMany({ collection, keys: [1] }, liveSignal);
			expect(create, String(collection)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
			expect(remove, String(collection)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(calls).toHaveLength(0);
	});

	it('refuses malformed and duplicate keys', async () => {
		const { host, writes } = makeHost();

		for (const key of [undefined, '', 1.5, { id: 1 }, [1], true, 'x'.repeat(256)]) {
			expect(await host.updateOne({ collection: 'articles', key, payload: { a: 1 } }, liveSignal)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' },
			});

			expect(await host.deleteOne({ collection: 'articles', key }, liveSignal)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' },
			});
		}

		for (const keys of [
			[1, 1],
			[1, undefined],
			['a', 'a'],
			[1, {}],
		]) {
			expect(await host.updateMany({ collection: 'articles', keys, payload: { a: 1 } }, liveSignal)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' },
			});

			expect(await host.deleteMany({ collection: 'articles', keys }, liveSignal)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' },
			});
		}

		expect(writes).toHaveLength(0);
	});

	it('refuses over-cap, empty, sparse, and non-array batches', async () => {
		const { host, writes } = makeHost();

		const overCapPayloads = Array.from({ length: ITEMS_MAX_LIMIT + 1 }, (_, i) => ({ i }));
		const overCapKeys = Array.from({ length: ITEMS_MAX_LIMIT + 1 }, (_, i) => i + 1);

		for (const reply of [
			await host.createMany({ collection: 'articles', payloads: overCapPayloads }, liveSignal),
			await host.createMany({ collection: 'articles', payloads: [] }, liveSignal),
			await host.createMany({ collection: 'articles', payloads: [{ a: 1 }, undefined] }, liveSignal),
			await host.createMany({ collection: 'articles', payloads: 'not-an-array' }, liveSignal),
			await host.createMany({ collection: 'articles', payloads: [{ a: 1 }, 7] }, liveSignal),
			await host.updateMany({ collection: 'articles', keys: overCapKeys, payload: { a: 1 } }, liveSignal),
			await host.deleteMany({ collection: 'articles', keys: [] }, liveSignal),
			await host.deleteMany({ collection: 'articles', keys: [1, undefined] }, liveSignal),
		]) {
			expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(writes).toHaveLength(0);
	});

	it('refuses a non-object payload', async () => {
		const { host, writes } = makeHost();

		for (const payload of [undefined, null, 'x', 7, [1]]) {
			expect(await host.createOne({ collection: 'articles', payload }, liveSignal)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' },
			});

			expect(await host.updateOne({ collection: 'articles', key: 1, payload }, liveSignal)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' },
			});
		}

		expect(writes).toHaveLength(0);
	});

	it('refuses a query key and any unsupported key on a write', async () => {
		const { host, writes } = makeHost();

		for (const reply of [
			await host.createOne({ collection: 'articles', payload: { a: 1 }, query: { limit: 1 } }, liveSignal),
			await host.deleteMany({ collection: 'articles', keys: [1], query: {} }, liveSignal),
			await host.createOne({ collection: 'articles', payload: { a: 1 }, surprise: true }, liveSignal),
		]) {
			expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(writes).toHaveLength(0);
	});

	it('shapes a write reply and refuses an over-cap reply at the surface', async () => {
		const { host } = makeHost();
		const created = await host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);
		expect(created).toEqual({ ok: true, value: 'created-1' });

		const big = serviceStub({ createOne: async () => 'x'.repeat(ITEMS_REPLY_BYTES + 1) });
		const { host: bigHost } = makeHost({ itemsService: () => big });
		const over = await bigHost.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);
		expect(over).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('passes relational and irregular payloads through to the service verbatim', async () => {
		const payloads: Partial<Item>[] = [
			{ title: 'x', author: { name: 'nested' } },
			{ tags: [{ name: 'a' }, { name: 'b' }] },
			{ author: 42 },
			{ title: 'x', count: 3, meta: { nested: { json: true } } },
			{ not_a_real_field: 'kept here, stripped by the service' },
		];

		for (const payload of payloads) {
			const { host, writes } = makeHost();
			const reply = await host.createOne({ collection: 'articles', payload }, liveSignal);
			expect(reply, JSON.stringify(payload)).toEqual({ ok: true, value: 'created-1' });
			expect(writes).toEqual([{ method: 'createOne', args: [payload] }]);
		}
	});

	it('treats a __proto__ object key as ordinary payload data', async () => {
		const { host, writes } = makeHost();
		const payload = JSON.parse('{"__proto__":{"role":"admin"},"title":"ok"}');

		const reply = await host.createOne({ collection: 'articles', payload }, liveSignal);

		expect(reply).toEqual({ ok: true, value: 'created-1' });
		expect(writes).toHaveLength(1);
		expect(Object.prototype.hasOwnProperty.call(writes[0]!.args[0], '__proto__')).toBe(true);
	});

	it('accepts a payload at the depth cap and refuses one past it', async () => {
		const nest = (levels: number) => {
			let node: Record<string, unknown> = { leaf: true };
			for (let i = 0; i < levels; i++) node = { child: node };
			return node;
		};

		const { host, writes } = makeHost();

		const atCap = await host.createOne({ collection: 'articles', payload: nest(CONFINED_WRITE_MAX_DEPTH) }, liveSignal);

		expect(atCap).toEqual({ ok: true, value: 'created-1' });

		const overCap = await host.createOne(
			{ collection: 'articles', payload: nest(CONFINED_WRITE_MAX_DEPTH + 1) },
			liveSignal
		);

		expect(overCap).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

		expect(writes).toHaveLength(1);
	});

	it('refuses a payload over the byte cap', async () => {
		const { host, writes } = makeHost();
		const payload = { blob: 'x'.repeat(CONFINED_WRITE_MAX_BYTES) };

		const reply = await host.createOne({ collection: 'articles', payload }, liveSignal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		expect(writes).toHaveLength(0);
	});

	it('maps a forbidden write to a sanitized denial on every verb', async () => {
		for (const testCase of writeInvocations) {
			const { host } = makeHost({ itemsService: () => allWritesThrow(() => new SeamForbidden()) });
			const reply = await testCase.invoke(host);
			expect(reply, testCase.verb).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
		}
	});

	it('maps a failed validation, single or array, to a sanitized invalid_request', async () => {
		for (const thrown of [new SeamFailedValidation(), [new SeamFailedValidation(), new SeamFailedValidation()]]) {
			const service = serviceStub({
				createOne: async () => {
					throw thrown;
				},
			});

			const { host } = makeHost({ itemsService: () => service });

			const reply = await host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);

			expect(reply).toEqual({ ok: false, error: { code: 'invalid_request', message: 'the write failed validation' } });
			expect(JSON.stringify(reply)).not.toContain('email');
		}
	});

	it('maps an invalid payload, ceiling overrun included, to a sanitized invalid_request', async () => {
		const service = serviceStub({
			createOne: async () => {
				throw new SeamInvalidPayload();
			},
		});

		const { host } = makeHost({ itemsService: () => service });

		const reply = await host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);

		expect(reply).toEqual({ ok: false, error: { code: 'invalid_request', message: 'the write request is invalid' } });
		expect(JSON.stringify(reply)).not.toContain('Exceeded');
	});

	it('maps an unknown write error to a sanitized internal error', async () => {
		const service = serviceStub({
			createOne: async () => {
				throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
			},
		});

		const { host } = makeHost({ itemsService: () => service });

		const reply = await host.createOne({ collection: 'articles', payload: { a: 1 } }, liveSignal);

		expect(reply).toEqual({ ok: false, error: { code: 'internal', message: 'the items write failed' } });
		expect(JSON.stringify(reply)).not.toContain('ECONNREFUSED');
	});

	it('never invokes the service when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		const { host, calls, writes } = makeHost();
		const reply = await host.createOne({ collection: 'articles', payload: { a: 1 } }, controller.signal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'timeout' } });
		expect(calls).toHaveLength(0);
		expect(writes).toHaveLength(0);
	});

	it('settles with a timeout when the write ignores the abort signal', async () => {
		const controller = new AbortController();
		const service = serviceStub({ createOne: () => new Promise<PrimaryKey>(() => undefined) });
		const { host } = makeHost({ itemsService: () => service });

		const pending = host.createOne({ collection: 'articles', payload: { a: 1 } }, controller.signal);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('ignores a late rejection after a timeout without a second reply or unhandled rejection', async () => {
		const controller = new AbortController();
		let rejectWrite: (error: unknown) => void = () => undefined;

		const service = serviceStub({
			createOne: () =>
				new Promise<PrimaryKey>((_resolve, reject) => {
					rejectWrite = reject;
				}),
		});

		const { host } = makeHost({ itemsService: () => service });

		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);

		try {
			const pending = host.createOne({ collection: 'articles', payload: { a: 1 } }, controller.signal);
			controller.abort();
			const reply = await pending;
			expect(reply).toMatchObject({ ok: false, error: { code: 'timeout' } });

			rejectWrite(new Error('late failure'));
			await new Promise((resolve) => setImmediate(resolve));

			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
