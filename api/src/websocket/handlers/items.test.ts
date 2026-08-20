import { BaseException } from '@cairncms/exceptions';
import type { SchemaOverview } from '@cairncms/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '../../exceptions/index.js';
import type { RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import type { CommandContext } from '../controllers/base.js';
import { WebSocketException } from '../exceptions.js';
import type { WebSocketMessage } from '../messages.js';
import { resolveTargetService } from '../target.js';
import { handleItems } from './items.js';

vi.mock('../target.js', () => ({ resolveTargetService: vi.fn() }));

const META = { total_count: 1 };

const metaMock = vi.hoisted(() => ({ getMetaForQuery: vi.fn() }));

vi.mock('../../services/index.js', () => ({
	MetaService: class {
		getMetaForQuery = metaMock.getMetaForQuery;
	},
}));

const resolveTarget = vi.mocked(resolveTargetService);

const ACCOUNTABILITY = {
	user: 'u',
	role: 'r',
	admin: false,
	app: true,
	ip: '1.1.1.1',
} as unknown as RequestAccountability;

function ctx(collection: string, singleton = false): CommandContext {
	return {
		schema: { collections: { [collection]: { collection, singleton } } } as unknown as SchemaOverview,
		accountability: ACCOUNTABILITY,
	};
}

function serviceSpy() {
	return {
		createOne: vi.fn().mockResolvedValue('k1'),
		createMany: vi.fn().mockResolvedValue(['k1', 'k2']),
		readOne: vi.fn().mockResolvedValue({ id: 'k1' }),
		readMany: vi.fn().mockResolvedValue([{ id: 'k1' }]),
		readSingleton: vi.fn().mockResolvedValue({ id: 'single' }),
		readByQuery: vi.fn().mockResolvedValue([{ id: 'k1' }]),
		updateOne: vi.fn().mockResolvedValue('k1'),
		updateMany: vi.fn().mockResolvedValue(['k1', 'k2']),
		upsertSingleton: vi.fn().mockResolvedValue('single'),
		updateByQuery: vi.fn().mockResolvedValue(['k1', 'k2']),
		deleteOne: vi.fn().mockResolvedValue('k1'),
		deleteMany: vi.fn().mockResolvedValue(['k1', 'k2']),
		deleteByQuery: vi.fn().mockResolvedValue(['k1', 'k2']),
	};
}

let service: ReturnType<typeof serviceSpy>;

beforeEach(() => {
	service = serviceSpy();
	resolveTarget.mockReset();
	resolveTarget.mockReturnValue(service as never);
	metaMock.getMetaForQuery.mockReset();

	metaMock.getMetaForQuery.mockImplementation(async (_collection: string, query: { meta?: unknown }) =>
		query?.meta ? META : undefined
	);
});

async function run(message: Record<string, unknown>, context: CommandContext) {
	const send = vi.fn(() => ({ accepted: true }));
	await handleItems(message as WebSocketMessage, context, send);
	return JSON.parse(send.mock.calls[0]![0] as string);
}

async function reject(message: Record<string, unknown>, context: CommandContext): Promise<WebSocketException> {
	const send = vi.fn(() => ({ accepted: true }));

	const error = await handleItems(message as WebSocketMessage, context, send).then(
		() => null,
		(caught) => caught
	);

	expect(send).not.toHaveBeenCalled();
	expect(error).toBeInstanceOf(WebSocketException);
	return error;
}

describe('handleItems create', () => {
	it('creates one item and reads it back with the query', async () => {
		const frame = await run(
			{ type: 'items', action: 'create', collection: 'articles', data: { title: 'x' }, uid: 1 },
			ctx('articles')
		);

		expect(service.createOne).toHaveBeenCalledWith({ title: 'x' });
		expect(service.readOne).toHaveBeenCalled();
		expect(frame).toMatchObject({ type: 'items', uid: 1, data: { id: 'k1' } });
		expect(frame.meta).toBeUndefined();
	});

	it('creates many items and reads them back', async () => {
		const frame = await run(
			{ type: 'items', action: 'create', collection: 'articles', data: [{ title: 'a' }, { title: 'b' }] },
			ctx('articles')
		);

		expect(service.createMany).toHaveBeenCalledWith([{ title: 'a' }, { title: 'b' }]);
		expect(service.readMany).toHaveBeenCalledWith(['k1', 'k2'], expect.anything());
		expect(frame.data).toEqual([{ id: 'k1' }]);
	});

	it('rejects a create against a singleton collection without touching the service', async () => {
		const error = await reject(
			{ type: 'items', action: 'create', collection: 'settings', data: { a: 1 }, uid: 2 },
			ctx('settings', true)
		);

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(error.uid).toBe(2);
		expect(service.createOne).not.toHaveBeenCalled();
		expect(service.createMany).not.toHaveBeenCalled();
	});
});

describe('handleItems read', () => {
	it('reads one by id and attaches the requested meta', async () => {
		const frame = await run(
			{ type: 'items', action: 'read', collection: 'articles', id: 'k1', query: { meta: ['total_count'] }, uid: 3 },
			ctx('articles')
		);

		expect(service.readOne).toHaveBeenCalledWith('k1', expect.anything());
		expect(frame).toMatchObject({ type: 'items', uid: 3, data: { id: 'k1' }, meta: META });
	});

	it('omits meta when the query does not request it', async () => {
		const frame = await run({ type: 'items', action: 'read', collection: 'articles', id: 'k1' }, ctx('articles'));

		expect(frame.meta).toBeUndefined();
	});

	it('honors a zero id rather than treating it as missing', async () => {
		await run({ type: 'items', action: 'read', collection: 'articles', id: 0 }, ctx('articles'));

		expect(service.readOne).toHaveBeenCalledWith(0, expect.anything());
		expect(service.readByQuery).not.toHaveBeenCalled();
	});

	it('accepts an id alongside a query as read-back options', async () => {
		await run(
			{ type: 'items', action: 'read', collection: 'articles', id: 'k1', query: { fields: ['id'] } },
			ctx('articles')
		);

		expect(service.readOne).toHaveBeenCalledWith('k1', expect.objectContaining({ fields: ['id'] }));
	});

	it('reads many by ids', async () => {
		await run({ type: 'items', action: 'read', collection: 'articles', ids: ['k1', 'k2'] }, ctx('articles'));
		expect(service.readMany).toHaveBeenCalledWith(['k1', 'k2'], expect.anything());
	});

	it('reads a singleton when no key is present', async () => {
		const frame = await run({ type: 'items', action: 'read', collection: 'settings' }, ctx('settings', true));
		expect(service.readSingleton).toHaveBeenCalled();
		expect(frame.data).toEqual({ id: 'single' });
	});

	it('reads by query for a non-singleton with no key', async () => {
		await run({ type: 'items', action: 'read', collection: 'articles', query: { limit: 5 } }, ctx('articles'));
		expect(service.readByQuery).toHaveBeenCalled();
	});

	it('rejects an id and ids together without touching the service', async () => {
		const error = await reject(
			{ type: 'items', action: 'read', collection: 'articles', id: 'k1', ids: ['k2'], uid: 9 },
			ctx('articles')
		);

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(error.uid).toBe(9);
		expect(service.readOne).not.toHaveBeenCalled();
		expect(service.readMany).not.toHaveBeenCalled();
	});

	it('rejects a malformed query before reaching the service', async () => {
		const error = await reject(
			{ type: 'items', action: 'read', collection: 'articles', query: { export: 'zip' } },
			ctx('articles')
		);

		expect(error.code).toBe('INVALID_QUERY');
		expect(service.readByQuery).not.toHaveBeenCalled();
	});
});

describe('handleItems update', () => {
	it('updates one by id and reads it back, without meta', async () => {
		const frame = await run(
			{ type: 'items', action: 'update', collection: 'articles', id: 'k1', data: { title: 'x' } },
			ctx('articles')
		);

		expect(service.updateOne).toHaveBeenCalledWith('k1', { title: 'x' });
		expect(service.readOne).toHaveBeenCalled();
		expect(frame.meta).toBeUndefined();
	});

	it('updates many by ids and attaches the requested meta', async () => {
		const frame = await run(
			{
				type: 'items',
				action: 'update',
				collection: 'articles',
				ids: ['k1', 'k2'],
				data: { title: 'x' },
				query: { meta: ['total_count'] },
			},
			ctx('articles')
		);

		expect(service.updateMany).toHaveBeenCalledWith(['k1', 'k2'], { title: 'x' });
		expect(service.readMany).toHaveBeenCalled();
		expect(frame.meta).toEqual(META);
	});

	it('upserts a singleton', async () => {
		await run({ type: 'items', action: 'update', collection: 'settings', data: { a: 1 } }, ctx('settings', true));
		expect(service.upsertSingleton).toHaveBeenCalledWith({ a: 1 });
		expect(service.readSingleton).toHaveBeenCalled();
	});

	it('updates by query when no key is present and attaches the requested meta', async () => {
		const frame = await run(
			{
				type: 'items',
				action: 'update',
				collection: 'articles',
				query: { limit: 5, meta: ['total_count'] },
				data: { title: 'x' },
			},
			ctx('articles')
		);

		expect(service.updateByQuery).toHaveBeenCalled();
		expect(frame.meta).toEqual(META);
	});

	it('rejects an update with no selector and never widens to updateByQuery', async () => {
		const error = await reject(
			{ type: 'items', action: 'update', collection: 'articles', data: { title: 'x' }, uid: 4 },
			ctx('articles')
		);

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(error.uid).toBe(4);
		expect(service.updateByQuery).not.toHaveBeenCalled();
	});
});

describe('handleItems delete', () => {
	it('deletes one by id and returns the id, without meta', async () => {
		const frame = await run(
			{ type: 'items', action: 'delete', collection: 'articles', id: 'k1', uid: 5 },
			ctx('articles')
		);

		expect(service.deleteOne).toHaveBeenCalledWith('k1');
		expect(frame).toMatchObject({ type: 'items', uid: 5, data: 'k1' });
		expect(frame.meta).toBeUndefined();
	});

	it('deletes many by ids and returns the ids', async () => {
		const frame = await run(
			{ type: 'items', action: 'delete', collection: 'articles', ids: ['k1', 'k2'] },
			ctx('articles')
		);

		expect(service.deleteMany).toHaveBeenCalledWith(['k1', 'k2']);
		expect(frame.data).toEqual(['k1', 'k2']);
	});

	it('deletes by query', async () => {
		await run({ type: 'items', action: 'delete', collection: 'articles', query: { limit: 5 } }, ctx('articles'));
		expect(service.deleteByQuery).toHaveBeenCalled();
	});

	it('rejects a delete with no selector and never widens to deleteByQuery', async () => {
		const error = await reject({ type: 'items', action: 'delete', collection: 'articles', uid: 6 }, ctx('articles'));

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(error.uid).toBe(6);
		expect(service.deleteByQuery).not.toHaveBeenCalled();
	});
});

describe('handleItems target and error envelopes', () => {
	it('rejects a denied target with an INVALID_COLLECTION items envelope carrying the uid', async () => {
		resolveTarget.mockReturnValue(null);

		const error = await reject(
			{ type: 'items', action: 'read', collection: 'directus_users', id: 'k1', uid: 7 },
			ctx('directus_users')
		);

		expect(error.type).toBe('items');
		expect(error.code).toBe('INVALID_COLLECTION');
		expect(error.uid).toBe(7);
	});

	it('surfaces a service ForbiddenException as a FORBIDDEN items envelope', async () => {
		service.readByQuery.mockRejectedValue(new ForbiddenException());
		const error = await reject({ type: 'items', action: 'read', collection: 'articles', uid: 8 }, ctx('articles'));

		expect(error).toMatchObject({ type: 'items', code: 'FORBIDDEN', uid: 8 });
		expect(error.message).toBe('The request could not be completed.');
	});

	it('never leaks a secret carried in a service error message', async () => {
		service.readByQuery.mockRejectedValue(new BaseException('denied for token=super-secret', 403, 'FORBIDDEN'));
		const error = await reject({ type: 'items', action: 'read', collection: 'articles' }, ctx('articles'));

		expect(error.code).toBe('FORBIDDEN');
		expect(error.toMessage()).not.toContain('super-secret');
	});

	it('maps a service error with a malformed code to INTERNAL_ERROR', async () => {
		service.readByQuery.mockRejectedValue(new BaseException('boom', 500, 'lowercase_code'));
		const error = await reject({ type: 'items', action: 'read', collection: 'articles' }, ctx('articles'));

		expect(error.code).toBe('INTERNAL_ERROR');
	});
});

describe('handleItems payload and query shape', () => {
	const badQueries: [string, unknown][] = [
		['null', null],
		['a string', 'everything'],
		['an array', [{ id: 'k1' }]],
	];

	it.each(badQueries)(
		'rejects an update whose query is %s without widening to updateByQuery',
		async (_label, query) => {
			const error = await reject(
				{ type: 'items', action: 'update', collection: 'articles', query, data: { title: 'x' }, uid: 1 },
				ctx('articles')
			);

			expect(error.code).toBe('INVALID_PAYLOAD');
			expect(service.updateByQuery).not.toHaveBeenCalled();
		}
	);

	it.each(badQueries)('rejects a delete whose query is %s without widening to deleteByQuery', async (_label, query) => {
		const error = await reject(
			{ type: 'items', action: 'delete', collection: 'articles', query, uid: 1 },
			ctx('articles')
		);

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(service.deleteByQuery).not.toHaveBeenCalled();
	});

	it('rejects a create whose data is not an object', async () => {
		const error = await reject(
			{ type: 'items', action: 'create', collection: 'articles', data: 'nope' },
			ctx('articles')
		);

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(service.createOne).not.toHaveBeenCalled();
	});

	it('rejects an update whose data is an array', async () => {
		const error = await reject(
			{ type: 'items', action: 'update', collection: 'articles', id: 'k1', data: [{ title: 'x' }] },
			ctx('articles')
		);

		expect(error.code).toBe('INVALID_PAYLOAD');
		expect(service.updateOne).not.toHaveBeenCalled();
	});
});

describe('handleItems read-back permission suppression', () => {
	it('acknowledges a create whose read-back is forbidden, without data', async () => {
		service.readOne.mockRejectedValue(new ForbiddenException());

		const frame = await run(
			{ type: 'items', action: 'create', collection: 'articles', data: { title: 'x' }, uid: 1 },
			ctx('articles')
		);

		expect(service.createOne).toHaveBeenCalled();
		expect(frame).toEqual({ type: 'items', uid: 1 });
	});

	it('acknowledges an update whose read-back is forbidden, without data', async () => {
		service.readOne.mockRejectedValue(new ForbiddenException());

		const frame = await run(
			{ type: 'items', action: 'update', collection: 'articles', id: 'k1', data: { title: 'x' } },
			ctx('articles')
		);

		expect(service.updateOne).toHaveBeenCalled();
		expect(frame.data).toBeUndefined();
	});

	it('still fails a create whose write itself is forbidden', async () => {
		service.createOne.mockRejectedValue(new ForbiddenException());

		const error = await reject(
			{ type: 'items', action: 'create', collection: 'articles', data: { title: 'x' }, uid: 2 },
			ctx('articles')
		);

		expect(error.code).toBe('FORBIDDEN');
		expect(error.uid).toBe(2);
	});

	it('does not suppress a forbidden read-back on a singleton update', async () => {
		service.readSingleton.mockRejectedValue(new ForbiddenException());

		const error = await reject(
			{ type: 'items', action: 'update', collection: 'settings', data: { a: 1 }, uid: 3 },
			ctx('settings', true)
		);

		expect(service.upsertSingleton).toHaveBeenCalled();
		expect(error.code).toBe('FORBIDDEN');
	});

	it('acknowledges a committed update whose requested meta lookup is forbidden, without data', async () => {
		metaMock.getMetaForQuery.mockRejectedValue(new ForbiddenException());

		const frame = await run(
			{
				type: 'items',
				action: 'update',
				collection: 'articles',
				ids: ['k1', 'k2'],
				data: { title: 'x' },
				query: { meta: ['total_count'] },
				uid: 4,
			},
			ctx('articles')
		);

		expect(service.updateMany).toHaveBeenCalled();
		expect(frame).toEqual({ type: 'items', uid: 4 });
	});
});
