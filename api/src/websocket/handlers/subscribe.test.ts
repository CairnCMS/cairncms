import type { SchemaOverview } from '@cairncms/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext, SocketClient } from '../controllers/base.js';
import { WebSocketException } from '../exceptions.js';
import type { WebSocketMessage } from '../messages.js';
import { resolveTargetService } from '../target.js';
import { getInitialPayload } from '../utils/items.js';

vi.mock('../config.js', () => ({ SUBSCRIPTIONS_PER_CONNECTION: 2, SUBSCRIPTIONS_PER_PROCESS: 10 }));
vi.mock('../target.js', () => ({ resolveTargetService: vi.fn() }));
vi.mock('../utils/items.js', () => ({ getInitialPayload: vi.fn() }));

const { handleSubscription } = await import('./subscribe.js');
const { SubscriptionRegistry } = await import('../subscriptions.js');

const resolveTarget = vi.mocked(resolveTargetService);
const initialPayload = vi.mocked(getInitialPayload);

const CONTEXT: CommandContext = {
	schema: { collections: {} } as unknown as SchemaOverview,
	accountability: { user: 'u', role: 'r', admin: false, app: true, ip: '1.1.1.1' } as never,
};

let registry: InstanceType<typeof SubscriptionRegistry>;

beforeEach(() => {
	registry = new SubscriptionRegistry();
	resolveTarget.mockReset();
	resolveTarget.mockReturnValue({} as never);
	initialPayload.mockReset();
	initialPayload.mockResolvedValue({ event: 'init', data: [] });
});

function makeClient(): SocketClient {
	return { stopping: false } as unknown as SocketClient;
}

function makeSend(accepted = true) {
	return vi.fn(() => ({ accepted }));
}

function run(client: SocketClient, message: Record<string, unknown>, send: ReturnType<typeof makeSend>) {
	return handleSubscription(client, message as WebSocketMessage, CONTEXT, send, registry);
}

async function reject(client: SocketClient, message: Record<string, unknown>, send: ReturnType<typeof makeSend>) {
	const error = await run(client, message, send).then(
		() => null,
		(caught) => caught
	);

	expect(error).toBeInstanceOf(WebSocketException);
	return error;
}

describe('handleSubscription subscribe', () => {
	it('registers a subscription and sends the initial payload', async () => {
		initialPayload.mockResolvedValue({ event: 'init', data: [{ id: 'k1' }] });
		const send = makeSend();
		await run(makeClient(), { type: 'subscribe', collection: 'articles', uid: 1 }, send);

		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(1);

		expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
			type: 'subscription',
			uid: '1',
			event: 'init',
			data: [{ id: 'k1' }],
		});
	});

	it('sends init without reading for an event-filtered subscription, item and event coexisting', async () => {
		const send = makeSend();
		await run(makeClient(), { type: 'subscribe', collection: 'articles', event: 'update', item: 0 }, send);

		expect(initialPayload).not.toHaveBeenCalled();
		expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({ type: 'subscription', event: 'init' });

		const [reservation] = registry.getActiveByCollection('articles', 999);
		expect(reservation!.subscription.item).toBe('0');
	});

	it('canonicalizes an equivalent numeric or string item to the same key', async () => {
		await run(makeClient(), { type: 'subscribe', collection: 'articles', event: 'update', item: 1 }, makeSend());
		await run(makeClient(), { type: 'subscribe', collection: 'articles', event: 'update', item: '1' }, makeSend());

		const items = registry.getActiveByCollection('articles', 999).map((reservation) => reservation.subscription.item);
		expect(items).toEqual(['1', '1']);
	});

	it('honors uid 0', async () => {
		const send = makeSend();
		await run(makeClient(), { type: 'subscribe', collection: 'articles', uid: 0 }, send);

		expect(JSON.parse(send.mock.calls[0]![0] as string).uid).toBe('0');
		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(1);
	});

	it('rejects a denied collection with INVALID_COLLECTION and registers nothing', async () => {
		resolveTarget.mockReturnValue(null);
		const send = makeSend();
		const error = await reject(makeClient(), { type: 'subscribe', collection: 'directus_users', uid: 7 }, send);

		expect(error).toMatchObject({ type: 'subscribe', code: 'INVALID_COLLECTION', uid: '7' });
		expect(registry.getSubscribedOwners()).toHaveLength(0);
		expect(send).not.toHaveBeenCalled();
	});

	it('rejects beyond the per-connection bound with SUBSCRIPTION_LIMIT and stays at the cap', async () => {
		const client = makeClient();
		await run(client, { type: 'subscribe', collection: 'articles', uid: 1 }, makeSend());
		await run(client, { type: 'subscribe', collection: 'articles', uid: 2 }, makeSend());
		const error = await reject(client, { type: 'subscribe', collection: 'articles', uid: 3 }, makeSend());

		expect(error.code).toBe('SUBSCRIPTION_LIMIT');
		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(2);
	});
});

describe('handleSubscription initialization lifecycle', () => {
	it('releases the reservation when the initial read fails', async () => {
		initialPayload.mockRejectedValue(new Error('boom'));
		const send = makeSend();
		await reject(makeClient(), { type: 'subscribe', collection: 'articles', uid: 1 }, send);

		expect(registry.getSubscribedOwners()).toHaveLength(0);
		expect(send).not.toHaveBeenCalled();
	});

	it('activates nothing when the connection closes during the initial read', async () => {
		const client = makeClient();

		initialPayload.mockImplementation(async () => {
			client.stopping = true;
			return { event: 'init', data: [] };
		});

		const send = makeSend();
		await run(client, { type: 'subscribe', collection: 'articles', uid: 1 }, send);

		expect(registry.getSubscribedOwners()).toHaveLength(0);
		expect(send).not.toHaveBeenCalled();
	});

	it('releases the reservation when the initial send is refused', async () => {
		const send = makeSend(false);
		await run(makeClient(), { type: 'subscribe', collection: 'articles', uid: 1 }, send);

		expect(registry.getSubscribedOwners()).toHaveLength(0);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('replaces a prior subscription with an equivalent numeric or string uid', async () => {
		const client = makeClient();
		await run(client, { type: 'subscribe', collection: 'articles', uid: 1 }, makeSend());
		await run(client, { type: 'subscribe', collection: 'articles', uid: '1' }, makeSend());

		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(1);
	});
});

describe('handleSubscription unsubscribe', () => {
	it('unsubscribes by uid and acknowledges, matching a numeric subscribe uid', async () => {
		const client = makeClient();
		await run(client, { type: 'subscribe', collection: 'articles', uid: 1 }, makeSend());

		const send = makeSend();
		await run(client, { type: 'unsubscribe', uid: 1 }, send);

		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(0);

		expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
			type: 'subscription',
			event: 'unsubscribe',
			uid: '1',
		});
	});

	it('unsubscribes all for the connection when no uid is given', async () => {
		const client = makeClient();
		await run(client, { type: 'subscribe', collection: 'articles', uid: 1 }, makeSend());
		await run(client, { type: 'subscribe', collection: 'posts', uid: 2 }, makeSend());

		await run(client, { type: 'unsubscribe' }, makeSend());
		expect(registry.getSubscribedOwners()).toHaveLength(0);
	});
});
