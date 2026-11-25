import knexLib from 'knex';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../services/items.js', () => {
	const ItemsService = vi.fn();
	ItemsService.prototype.updateByQuery = vi.fn();
	ItemsService.prototype.updateOne = vi.fn();
	ItemsService.prototype.updateMany = vi.fn();
	return { ItemsService };
});

vi.mock('../../utils/get-accountability-for-role.js', () => ({
	getAccountabilityForRole: vi.fn((role: string | null, _context) => Promise.resolve(role)),
}));

import { ItemsService } from '../../services/items.js';
import { getAccountabilityForRole } from '../../utils/get-accountability-for-role.js';
import config from './index.js';

const testCollection = 'test';
const testPayload = {};
const testId = '00000000-0000-0000-0000-000000000000';
const testAccountability = { user: testId, role: testId };

const getSchema = vi.fn().mockResolvedValue({});

describe('Operations / Item Update', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	test.each([
		{ permissions: undefined, expected: testAccountability },
		{ permissions: '$trigger', expected: testAccountability },
		{ permissions: '$full', expected: 'system' },
		{ permissions: '$public', expected: null },
		{ permissions: 'test', expected: 'test' },
	])('accountability for permissions "$permissions" should be $expected', async ({ permissions, expected }) => {
		await config.handler(
			{ collection: testCollection, payload: testPayload, key: 1, permissions } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService)).toHaveBeenCalledWith(
			testCollection,
			expect.objectContaining({ schema: {}, accountability: expected, knex: undefined })
		);
	});

	test('should return null when payload is not defined', async () => {
		const result = await config.handler(
			{ collection: testCollection } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(result).toBe(null);
		expect(vi.mocked(ItemsService).prototype.updateByQuery).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateOne).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateMany).not.toHaveBeenCalled();
	});

	test.each([undefined, []])('should call updateByQuery with correct query when key is $payload', async (key) => {
		const query = { limit: -1 };

		await config.handler(
			{ collection: testCollection, payload: testPayload, query, key } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateByQuery).toHaveBeenCalledWith(query, testPayload, expect.anything());
		expect(vi.mocked(ItemsService).prototype.updateOne).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateMany).not.toHaveBeenCalled();
	});

	test('should emit events for updateByQuery when true', async () => {
		const query = { limit: -1 };

		await config.handler(
			{ collection: testCollection, payload: testPayload, query, emitEvents: true } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateByQuery).toHaveBeenCalledWith(query, testPayload, {
			emitEvents: true,
		});
	});

	test.each([undefined, false])('should not emit events for updateByQuery when %s', async (emitEvents) => {
		const query = { limit: -1 };

		await config.handler(
			{ collection: testCollection, payload: testPayload, query, emitEvents } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateByQuery).toHaveBeenCalledWith(query, testPayload, {
			emitEvents: false,
		});
	});

	test.each([1, [1]])('should call updateOne when key is $payload', async (key) => {
		await config.handler(
			{ collection: testCollection, payload: testPayload, key } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateByQuery).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateOne).toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateMany).not.toHaveBeenCalled();
	});

	test('should emit events for updateOne when true', async () => {
		const key = 1;

		await config.handler(
			{ collection: testCollection, payload: testPayload, key, emitEvents: true } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateOne).toHaveBeenCalledWith(key, testPayload, { emitEvents: true });
	});

	test.each([undefined, false])('should not emit events for updateOne when %s', async (emitEvents) => {
		const key = 1;

		await config.handler(
			{ collection: testCollection, payload: testPayload, key: key, emitEvents } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateOne).toHaveBeenCalledWith(key, testPayload, { emitEvents: false });
	});

	test('should call updateMany when key is an array with more than one item', async () => {
		await config.handler(
			{ collection: testCollection, payload: testPayload, key: [1, 2, 3] } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateByQuery).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateOne).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateMany).toHaveBeenCalled();
	});

	test('should emit events for updateMany when true', async () => {
		const keys = [1, 2, 3];

		await config.handler(
			{ collection: testCollection, payload: testPayload, key: keys, emitEvents: true } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateMany).toHaveBeenCalledWith(keys, testPayload, { emitEvents: true });
	});

	test.each([undefined, false])('should not emit events for updateMany when %s', async (emitEvents) => {
		const keys = [1, 2, 3];

		await config.handler(
			{ collection: testCollection, payload: testPayload, key: keys, emitEvents } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(vi.mocked(ItemsService).prototype.updateMany).toHaveBeenCalledWith(keys, testPayload, { emitEvents: false });
	});
});

describe('Operations / Item Update / targets', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	const keysMode = { storedTargets: { key: 'configured', query: 'none' } };
	const queryMode = { storedTargets: { key: 'none', query: 'configured' } };

	function run(options: Record<string, unknown>, context: Record<string, unknown> = {}) {
		return config.handler(
			{ collection: testCollection, payload: testPayload, permissions: '$full', ...options } as any,
			{ accountability: testAccountability, getSchema, ...context } as any
		);
	}

	function expectNothingRead() {
		expect(getSchema).not.toHaveBeenCalled();
		expect(vi.mocked(getAccountabilityForRole)).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateOne).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateMany).not.toHaveBeenCalled();
		expect(vi.mocked(ItemsService).prototype.updateByQuery).not.toHaveBeenCalled();
	}

	test.each([{ key: [] }, { key: [[]] }])(
		'returns [] for the empty list $key without reading anything',
		async ({ key }) => {
			await expect(run({ key }, keysMode)).resolves.toEqual([]);
			expectNothingRead();
		}
	);

	test.each([
		{ key: null },
		{ key: '' },
		{ key: [null] },
		{ key: [''] },
		{ key: true },
		{ key: {} },
		{ key: NaN },
		{ key: [true] },
		{ key: [5, {}] },
		{ key: [[true]] },
		{ key: [[null]] },
	])('refuses the keys $key with INVALID_PAYLOAD without reading anything', async ({ key }) => {
		await expect(run({ key }, keysMode)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
		expectNothingRead();
	});

	test.each([
		{ key: [5, ''], method: 'updateMany', expected: [5, ''] },
		{ key: ['undefined'], method: 'updateOne', expected: 'undefined' },
		{ key: [[2, 3]], method: 'updateOne', expected: [2, 3] },
		{ key: [[2, '']], method: 'updateOne', expected: [2, ''] },
		{ key: 0, method: 'updateOne', expected: 0 },
		{ key: [0], method: 'updateOne', expected: 0 },
	])('passes the keys $key to $method', async ({ key, method, expected }) => {
		await run({ key }, keysMode);

		expect((vi.mocked(ItemsService).prototype as any)[method]).toHaveBeenCalledWith(
			expected,
			testPayload,
			expect.anything()
		);
	});

	test('returns null without a payload, before checking an empty key list', async () => {
		await expect(run({ key: [], payload: undefined }, keysMode)).resolves.toBe(null);
		expectNothingRead();
	});

	test.each([{ query: undefined }, { query: null }, { query: '' }, { query: '   ' }, { query: {} }])(
		'refuses the blank query $query with INVALID_CONFIG without decoding it',
		async ({ query }) => {
			await expect(run({ query }, { storedTargets: { key: 'none', query: 'none' } })).rejects.toMatchObject({
				code: 'INVALID_CONFIG',
			});

			expectNothingRead();
		}
	);

	test.each([{ query: '' }, { query: '   ' }])(
		'refuses a saved query that resolves to the blank text $query with INVALID_CONFIG',
		async ({ query }) => {
			await expect(run({ query }, queryMode)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
			expectNothingRead();
		}
	);

	test.each([{ query: 'null' }, { query: { foo: 1 } }, { query: { sort: ['id'] } }, { query: { filter: {} } }])(
		'refuses the query $query with INVALID_CONFIG without reading anything',
		async ({ query }) => {
			await expect(run({ query }, queryMode)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
			expectNothingRead();
		}
	);

	test.each([
		{ query: { limit: 'abc' } },
		{ query: { limit: true } },
		{ query: { limit: '' } },
		{ query: { limit: 1.5 } },
		{ query: { limit: -2 } },
		{ query: { limit: 'abc', search: 'paid' } },
	])('refuses the invalid limit in $query with INVALID_QUERY without reading anything', async ({ query }) => {
		await expect(run({ query }, queryMode)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		expectNothingRead();
	});

	test('keeps the keys path when the saved query is blank text', async () => {
		await run({ key: [5], query: '   ' }, keysMode);
		expect(vi.mocked(ItemsService).prototype.updateOne).toHaveBeenCalledWith(5, testPayload, expect.anything());
	});

	test.each([
		{ query: { search: 'paid' } },
		{ query: { limit: 2 } },
		{ query: { limit: '2' } },
		{ query: { limit: -1 } },
	])('updates by the query $query', async ({ query }) => {
		await run({ query }, queryMode);
		expect(vi.mocked(ItemsService).prototype.updateByQuery).toHaveBeenCalledOnce();
	});

	describe('when the filter is the only selector', () => {
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
				[testCollection]: {
					collection: testCollection,
					primary: 'id',
					singleton: false,
					note: null,
					sortField: null,
					accountability: 'all',
					fields: { id: field('id', 'integer'), status: field('status', 'string') },
				},
			},
			relations: [],
		};

		const context = {
			...queryMode,
			accountability: { admin: true, role: null, user: null },
			database: knexLib({ client: 'pg' }),
			getSchema: vi.fn().mockResolvedValue(schema),
		};

		test('updates when the builder turns the filter into a condition', async () => {
			await run({ query: { filter: { id: { _eq: 1 } } }, permissions: '$trigger' }, context);
			expect(vi.mocked(ItemsService).prototype.updateByQuery).toHaveBeenCalledOnce();
		});

		test('refuses before updating when the builder drops the filter', async () => {
			await expect(run({ query: { filter: { _and: [] } }, permissions: '$trigger' }, context)).rejects.toMatchObject({
				code: 'INVALID_CONFIG',
			});

			expect(vi.mocked(ItemsService).prototype.updateByQuery).not.toHaveBeenCalled();
		});
	});

	test('a direct caller without stored targets reads an empty resolved key as query mode', async () => {
		await run({ key: [], query: { limit: -1 } });
		expect(vi.mocked(ItemsService).prototype.updateByQuery).toHaveBeenCalledOnce();
	});

	test('a direct caller without stored targets is refused keys and a query together', async () => {
		await expect(run({ key: [5], query: { limit: 2 } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
		expectNothingRead();
	});
});
