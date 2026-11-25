import knexLib from 'knex';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ItemsService } from '../../services/items.js';
import { getAccountabilityForRole } from '../../utils/get-accountability-for-role.js';
import config from './index.js';

vi.mock('../../services/items.js', () => {
	const ItemsService = vi.fn();
	ItemsService.prototype.deleteByQuery = vi.fn();
	ItemsService.prototype.deleteOne = vi.fn();
	ItemsService.prototype.deleteMany = vi.fn();
	return { ItemsService };
});

const getSchema = vi.fn().mockResolvedValue({});

vi.mock('../../utils/get-accountability-for-role.js', () => ({
	getAccountabilityForRole: vi.fn((role: string | null, _context) => Promise.resolve(role)),
}));

const testCollection = 'test';
const testQuery = { limit: -1 };
const testId = '00000000-0000-0000-0000-000000000000';
const testAccountability = { user: testId, role: testId };

describe('Operations / Item Delete', () => {
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
			{ collection: testCollection, query: testQuery, permissions } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService).toHaveBeenCalledWith(
			testCollection,
			expect.objectContaining({ schema: {}, accountability: expected, knex: undefined })
		);
	});

	test('refuses a step with neither keys nor a query', async () => {
		await expect(
			config.handler({ collection: testCollection } as any, { accountability: testAccountability, getSchema } as any)
		).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

		expect(getSchema).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteByQuery).not.toHaveBeenCalled();
	});

	test.each([undefined, []])('should call deleteByQuery with correct query when key is $payload', async (key) => {
		await config.handler(
			{ collection: testCollection, query: testQuery, key } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteByQuery).toHaveBeenCalledWith(testQuery, expect.anything());
		expect(ItemsService.prototype.deleteOne).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteMany).not.toHaveBeenCalled();
	});

	test('should emit events for deleteByQuery when true', async () => {
		await config.handler(
			{ collection: testCollection, query: testQuery, emitEvents: true } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteByQuery).toHaveBeenCalledWith(testQuery, { emitEvents: true });
	});

	test.each([undefined, false])('should not emit events for deleteByQuery when %s', async (emitEvents) => {
		await config.handler(
			{ collection: testCollection, query: testQuery, emitEvents } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteByQuery).toHaveBeenCalledWith(testQuery, { emitEvents: false });
	});

	test.each([1, [1]])('should call deleteOne when key is $payload', async (key) => {
		await config.handler(
			{ collection: testCollection, key } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteByQuery).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteOne).toHaveBeenCalled();
		expect(ItemsService.prototype.deleteMany).not.toHaveBeenCalled();
	});

	test('should emit events for deleteOne when true', async () => {
		const key = 1;

		await config.handler(
			{ collection: testCollection, key, emitEvents: true } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteOne).toHaveBeenCalledWith(key, { emitEvents: true });
	});

	test.each([undefined, false])('should not emit events for deleteOne when %s', async (emitEvents) => {
		const key = 1;

		await config.handler(
			{ collection: testCollection, key, emitEvents } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteOne).toHaveBeenCalledWith(key, { emitEvents: false });
	});

	test('should call deleteMany when key is an array with more than one item', async () => {
		await config.handler(
			{ collection: testCollection, key: [1, 2, 3] } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteByQuery).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteOne).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteMany).toHaveBeenCalled();
	});

	test('should emit events for deleteMany when true', async () => {
		const keys = [1, 2, 3];

		await config.handler(
			{ collection: testCollection, key: keys, emitEvents: true } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteMany).toHaveBeenCalledWith(keys, { emitEvents: true });
	});

	test.each([undefined, false])('should not emit events for deleteMany when %s', async (emitEvents) => {
		const keys = [1, 2, 3];

		await config.handler(
			{ collection: testCollection, key: keys, emitEvents } as any,
			{ accountability: testAccountability, getSchema } as any
		);

		expect(ItemsService.prototype.deleteMany).toHaveBeenCalledWith(keys, { emitEvents: false });
	});
});

describe('Operations / Item Delete / targets', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	const keysMode = { storedTargets: { key: 'configured', query: 'none' } };
	const queryMode = { storedTargets: { key: 'none', query: 'configured' } };

	function run(options: Record<string, unknown>, context: Record<string, unknown> = {}) {
		return config.handler(
			{ collection: testCollection, permissions: '$full', ...options } as any,
			{ accountability: testAccountability, getSchema, ...context } as any
		);
	}

	function expectNothingRead() {
		expect(getSchema).not.toHaveBeenCalled();
		expect(vi.mocked(getAccountabilityForRole)).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteOne).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteMany).not.toHaveBeenCalled();
		expect(ItemsService.prototype.deleteByQuery).not.toHaveBeenCalled();
	}

	test.each([{ key: [] }, { key: [[]] }])(
		'returns [] for the empty list $key without reading anything',
		async ({ key }) => {
			await expect(run({ key }, keysMode)).resolves.toEqual([]);
			expectNothingRead();
		}
	);

	test.each([{ key: null }, { key: '' }, { key: [null] }, { key: [''] }, { key: true }, { key: [5, {}] }])(
		'refuses the keys $key with INVALID_PAYLOAD without reading anything',
		async ({ key }) => {
			await expect(run({ key }, keysMode)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
			expectNothingRead();
		}
	);

	test.each([
		{ key: 0, method: 'deleteOne', expected: 0 },
		{ key: [[2, 3]], method: 'deleteOne', expected: [2, 3] },
		{ key: [5, ''], method: 'deleteMany', expected: [5, ''] },
	])('passes the keys $key to $method', async ({ key, method, expected }) => {
		await run({ key }, keysMode);
		expect((ItemsService.prototype as any)[method]).toHaveBeenCalledWith(expected, expect.anything());
	});

	test.each([{ query: undefined }, { query: '   ' }, { query: {} }])(
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

	test.each([{ query: 'null' }, { query: { sort: ['id'] } }])(
		'refuses the query $query with INVALID_CONFIG without reading anything',
		async ({ query }) => {
			await expect(run({ query }, queryMode)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
			expectNothingRead();
		}
	);

	test.each([{ query: { limit: 'abc' } }, { query: { limit: 1.5, filter: { id: { _eq: 1 } } } }])(
		'refuses the invalid limit in $query with INVALID_QUERY without reading anything',
		async ({ query }) => {
			await expect(run({ query }, queryMode)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
			expectNothingRead();
		}
	);

	test('keeps the keys path when the saved query is blank text', async () => {
		await run({ key: [5], query: '   ' }, keysMode);
		expect(ItemsService.prototype.deleteOne).toHaveBeenCalledWith(5, expect.anything());
	});

	test.each([{ query: { search: 'old' } }, { query: { limit: '2' } }])(
		'deletes by the query $query',
		async ({ query }) => {
			await run({ query }, queryMode);
			expect(ItemsService.prototype.deleteByQuery).toHaveBeenCalledOnce();
		}
	);

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

		test('deletes when the builder turns the filter into a condition', async () => {
			await run({ query: { filter: { id: { _eq: 1 } } }, permissions: '$trigger' }, context);
			expect(ItemsService.prototype.deleteByQuery).toHaveBeenCalledOnce();
		});

		test('refuses before deleting when the builder drops the filter', async () => {
			await expect(
				run({ query: { filter: { id: { _between: [10] } } }, permissions: '$trigger' }, context)
			).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

			expect(ItemsService.prototype.deleteByQuery).not.toHaveBeenCalled();
		});
	});

	test('a direct caller without stored targets is refused keys and a query together', async () => {
		await expect(run({ key: [5], query: { limit: 2 } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
		expectNothingRead();
	});
});
