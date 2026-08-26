import type { EventContext, Query } from '@cairncms/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocketClient } from './controllers/base.js';
import type { WebSocketEvent } from './messages.js';

vi.mock('./config.js', () => ({
	SUBSCRIPTIONS_PER_CONNECTION: 100,
	SUBSCRIPTIONS_PER_PROCESS: 10_000,
	SOURCE_EVENT_QUEUE_COUNT: 1000,
	SOURCE_EVENT_QUEUE_BYTES: 100_000,
	OUTBOUND_FRAME_CAP: 1_048_576,
	OUTBOUND_QUEUE_BYTES: 1_048_576,
	DELIVERY_CONCURRENCY: 5,
}));

vi.mock('./target.js', () => ({ resolveTargetService: vi.fn(() => ({})) }));

vi.mock('./utils/items.js', () => ({
	getInitialPayload: vi.fn(),
	getEventPayload: vi.fn(async () => ({ event: 'create', data: [{ id: 1 }] })),
}));

vi.mock('./utils/message.js', () => ({
	fmtMessage: (type: string, data: Record<string, unknown>, uid?: string) => JSON.stringify({ type, ...data, uid }),
	safeSend: vi.fn(() => ({ accepted: true })),
}));

const emitter = (await import('../emitter.js')).default;
const { getMessenger } = await import('../messenger.js');
const { HookEventProducer } = await import('./controllers/hooks.js');
const { DispatchCoordinator } = await import('./dispatch.js');
const { SubscriptionRegistry } = await import('./subscriptions.js');
const { safeSend } = await import('./utils/message.js');

const send = vi.mocked(safeSend);
const CONTEXT = { database: {}, schema: null, accountability: null } as unknown as EventContext;

let producer: InstanceType<typeof HookEventProducer> | null = null;
let coordinator: InstanceType<typeof DispatchCoordinator> | null = null;
let readHook: ReturnType<typeof vi.fn> | null = null;

afterEach(async () => {
	producer?.destroy();
	await coordinator?.stop();
	if (readHook) emitter.offFilter('items.read', readHook as never);
	producer = null;
	coordinator = null;
	readHook = null;
	send.mockClear();
});

function client(): SocketClient {
	return {
		stopping: false,
		auth: { snapshotAccountability: vi.fn().mockResolvedValue({ user: 'u', role: 'r', admin: false, app: true }) },
	} as unknown as SocketClient;
}

function adminClient(): SocketClient {
	return {
		stopping: false,
		auth: { snapshotAccountability: vi.fn().mockResolvedValue({ admin: true }) },
	} as unknown as SocketClient;
}

describe('realtime dispatch wired through the messenger', () => {
	it('delivers a mutation to a subscribed connection through the producer and coordinator', async () => {
		const messenger = getMessenger();
		const registry = new SubscriptionRegistry();

		producer = new HookEventProducer(messenger);
		producer.register();

		coordinator = new DispatchCoordinator({
			registry,
			getSchema: async () => ({ collections: {} } as never),
			messenger,
			closeConnection: vi.fn(),
			deliveryConcurrency: 5,
		});

		coordinator.start();

		const reservation = registry.reserve({ client: client(), collection: 'articles', query: {} as Query });
		if (reservation.ok) reservation.reservation.activate();

		emitter.emitAction('items.create', { collection: 'articles', key: 1 }, CONTEXT);

		await vi.waitFor(() => expect(send).toHaveBeenCalled());
		expect(JSON.parse(send.mock.calls[0]![1] as string)).toMatchObject({ type: 'subscription', event: 'create' });
	});

	it('delivers the event to a subscription sink and bypasses the REST send path', async () => {
		const messenger = getMessenger();
		const registry = new SubscriptionRegistry();

		producer = new HookEventProducer(messenger);
		producer.register();

		coordinator = new DispatchCoordinator({
			registry,
			getSchema: async () => ({ collections: {} } as never),
			messenger,
			closeConnection: vi.fn(),
			deliveryConcurrency: 5,
		});

		coordinator.start();

		const events: WebSocketEvent[] = [];

		const reservation = registry.reserve({
			client: client(),
			collection: 'articles',
			query: {} as Query,
			sink: async (event) => {
				events.push(event);
			},
		});

		if (reservation.ok) reservation.reservation.activate();

		emitter.emitAction('items.create', { collection: 'articles', key: 1 }, CONTEXT);

		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ action: 'create', collection: 'articles', key: 1 });
		expect(send).not.toHaveBeenCalled();
	});

	it('delivers an eligible delete feed and never invokes an items.read hook', async () => {
		const messenger = getMessenger();
		const registry = new SubscriptionRegistry();

		readHook = vi.fn(async (payload) => payload);
		emitter.onFilter('items.read', readHook as never);

		producer = new HookEventProducer(messenger);
		producer.register();

		coordinator = new DispatchCoordinator({
			registry,
			getSchema: async () => ({ collections: { articles: { primary: 'id' } } } as never),
			messenger,
			closeConnection: vi.fn(),
			deliveryConcurrency: 5,
		});

		coordinator.start();

		const reservation = registry.reserve({
			client: adminClient(),
			collection: 'articles',
			query: {} as Query,
			event: 'delete',
		});

		if (reservation.ok) reservation.reservation.activate();

		emitter.emitAction('items.delete', { collection: 'articles', keys: [1] }, CONTEXT);

		await vi.waitFor(() => expect(send).toHaveBeenCalled());

		expect(JSON.parse(send.mock.calls[0]![1] as string)).toMatchObject({
			type: 'subscription',
			event: 'delete',
			data: [1],
		});

		expect(readHook).not.toHaveBeenCalled();
	});
});
