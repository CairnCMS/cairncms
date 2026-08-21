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

const { getInitialPayload } = await import('./items.js');

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
