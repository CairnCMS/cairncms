import type { Query, SchemaOverview } from '@cairncms/types';
import { describe, expect, it, vi } from 'vitest';
import type { SocketClient } from '../controllers/base.js';
import type { RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import type { Subscription } from '../subscriptions.js';

const META = { total_count: 1 };

vi.mock('../../services/index.js', () => ({
	MetaService: class {
		async getMetaForQuery() {
			return META;
		}
	},
}));

const { getInitialPayload, getEventPayload } = await import('./items.js');

const ACCOUNTABILITY = {
	user: 'u',
	role: 'r',
	admin: false,
	app: true,
	ip: '1.1.1.1',
} as unknown as RequestAccountability;

const SCHEMA = { collections: {} } as unknown as SchemaOverview;

function serviceSpy() {
	return {
		readOne: vi.fn().mockResolvedValue({ id: 'k1' }),
		readByQuery: vi.fn().mockResolvedValue([{ id: 'k1' }]),
		readMany: vi.fn().mockResolvedValue([{ id: 'k1' }]),
	};
}

function sub(collection: string, extra: Partial<Subscription> = {}): Subscription {
	return { client: {} as SocketClient, collection, query: {} as Query, ...extra };
}

describe('getInitialPayload', () => {
	it('reads by query for an unfiltered multi subscription', async () => {
		const service = serviceSpy();

		const result = await getInitialPayload(
			service as never,
			sub('articles', { query: { limit: 5 } as Query }),
			ACCOUNTABILITY,
			SCHEMA
		);

		expect(service.readByQuery).toHaveBeenCalledWith({ limit: 5 });
		expect(result).toMatchObject({ event: 'init', data: [{ id: 'k1' }] });
		expect(result['meta']).toBeUndefined();
	});

	it('reads one for an item subscription with the canonical item key', async () => {
		const service = serviceSpy();
		await getInitialPayload(service as never, sub('articles', { item: '0' }), ACCOUNTABILITY, SCHEMA);

		expect(service.readOne).toHaveBeenCalledWith('0', expect.anything());
		expect(service.readByQuery).not.toHaveBeenCalled();
	});

	it('attaches meta only when the query requests it', async () => {
		const service = serviceSpy();

		const withMeta = await getInitialPayload(
			service as never,
			sub('articles', { query: { meta: ['total_count'] } as unknown as Query }),
			ACCOUNTABILITY,
			SCHEMA
		);

		expect(withMeta['meta']).toEqual(META);

		const withoutMeta = await getInitialPayload(service as never, sub('articles'), ACCOUNTABILITY, SCHEMA);
		expect(withoutMeta['meta']).toBeUndefined();
	});
});

describe('getEventPayload', () => {
	it('reads the created key for a create event', async () => {
		const service = serviceSpy();

		const result = await getEventPayload(service as never, sub('articles'), ACCOUNTABILITY, SCHEMA, {
			action: 'create',
			collection: 'articles',
			key: 'k1',
		});

		expect(service.readMany).toHaveBeenCalledWith(['k1'], {});
		expect(result).toMatchObject({ event: 'create', data: [{ id: 'k1' }] });
		expect(result['meta']).toBeUndefined();
	});

	it('reads the updated keys for an update event, with meta when requested', async () => {
		const service = serviceSpy();

		const result = await getEventPayload(
			service as never,
			sub('articles', { query: { meta: ['total_count'] } as unknown as Query }),
			ACCOUNTABILITY,
			SCHEMA,
			{ action: 'update', collection: 'articles', keys: ['k1', 'k2'] }
		);

		expect(service.readMany).toHaveBeenCalledWith(['k1', 'k2'], { meta: ['total_count'] });
		expect(result).toMatchObject({ event: 'update', data: [{ id: 'k1' }], meta: META });
	});

	it('narrows a batch update to the subscribed numeric item, preserving key type', async () => {
		const service = serviceSpy();

		await getEventPayload(service as never, sub('articles', { item: '1' }), ACCOUNTABILITY, SCHEMA, {
			action: 'update',
			collection: 'articles',
			keys: [1, 2],
		});

		expect(service.readMany).toHaveBeenCalledWith([1], {});
	});

	it('narrows a batch update to the subscribed string item, preserving key type', async () => {
		const service = serviceSpy();

		await getEventPayload(service as never, sub('articles', { item: '2' }), ACCOUNTABILITY, SCHEMA, {
			action: 'update',
			collection: 'articles',
			keys: ['1', '2'],
		});

		expect(service.readMany).toHaveBeenCalledWith(['2'], {});
	});
});
