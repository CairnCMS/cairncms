import type { EventContext, Query } from '@cairncms/types';
import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SocketClient } from './controllers/base.js';
import type { WebSocketEvent } from './messages.js';
import type { AbstractServiceOptions } from '../types/services.js';

type PostRow = { id: string; title: string; uploaded_by: string | null };

const targetHolder = vi.hoisted(() => ({
	resolve: (_collection: string, _options: AbstractServiceOptions): unknown => null,
}));

vi.mock('./config.js', () => ({
	SUBSCRIPTIONS_PER_CONNECTION: 100,
	SUBSCRIPTIONS_PER_PROCESS: 10_000,
	SOURCE_EVENT_QUEUE_COUNT: 1000,
	SOURCE_EVENT_QUEUE_BYTES: 100_000,
	OUTBOUND_FRAME_CAP: 1_048_576,
	OUTBOUND_QUEUE_BYTES: 1_048_576,
	DELIVERY_CONCURRENCY: 5,
}));

vi.mock('./target.js', () => ({
	resolveTargetService: (collection: string, options: AbstractServiceOptions) =>
		targetHolder.resolve(collection, options),
}));

vi.mock('./utils/items.js', async () => ({
	...(await vi.importActual('./utils/items.js')),
	getInitialPayload: vi.fn(),
}));

vi.mock('../database/index.js', () => ({ default: vi.fn(), getDatabaseClient: vi.fn(() => 'postgres') }));

vi.mock('../cache', () => ({
	getCache: vi.fn().mockReturnValue({ cache: { clear: vi.fn() }, systemCache: { clear: vi.fn() } }),
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
const { ItemsService } = await import('../services/index.js');
const { userSchema } = await import('../__utils__/schemas.js');

const db = vi.mocked(knex.default({ client: MockClient }));
let tracker: Tracker;

targetHolder.resolve = (collection: string, options: AbstractServiceOptions) =>
	new ItemsService(collection, { ...options, knex: db });

const send = vi.mocked(safeSend);
const CONTEXT = { database: {}, schema: null, accountability: null } as unknown as EventContext;
const POST_KEY = '11111111-1111-1111-1111-111111111111';

let producer: InstanceType<typeof HookEventProducer> | null = null;
let coordinator: InstanceType<typeof DispatchCoordinator> | null = null;
let readHook: ReturnType<typeof vi.fn> | null = null;
let queryHook: ReturnType<typeof vi.fn> | null = null;

beforeAll(() => {
	tracker = createTracker(db);
});

afterEach(async () => {
	producer?.destroy();
	await coordinator?.stop();
	if (readHook) emitter.offFilter('items.read', readHook as never);
	if (queryHook) emitter.offFilter('items.query', queryHook as never);
	producer = null;
	coordinator = null;
	readHook = null;
	queryHook = null;
	tracker.reset();
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
	it('runs the real read path so items.query and items.read shape the delivered payload', async () => {
		const messenger = getMessenger();
		const registry = new SubscriptionRegistry();

		queryHook = vi.fn(async (query: Query) => ({ ...query, fields: ['id', 'title'] }));
		emitter.onFilter('items.query', queryHook as never);

		readHook = vi.fn(async (rows: PostRow[]) => rows.map((row) => ({ ...row, title: `read:${row.title}` })));
		emitter.onFilter('items.read', readHook as never);

		tracker.on.select('posts').response([{ id: POST_KEY, title: 'hello', uploaded_by: null }] satisfies PostRow[]);

		producer = new HookEventProducer(messenger);
		producer.register();

		coordinator = new DispatchCoordinator({
			registry,
			getSchema: async () => userSchema as never,
			messenger,
			closeConnection: vi.fn(),
			deliveryConcurrency: 5,
		});

		coordinator.start();

		const reservation = registry.reserve({ client: adminClient(), collection: 'posts', query: {} as Query });
		if (reservation.ok) reservation.reservation.activate();

		emitter.emitAction('items.create', { collection: 'posts', key: POST_KEY }, CONTEXT);

		await vi.waitFor(() => expect(send).toHaveBeenCalled());

		const frame = JSON.parse(send.mock.calls[0]![1] as string);

		expect(frame).toMatchObject({ type: 'subscription', event: 'create' });
		expect(queryHook).toHaveBeenCalled();
		expect(readHook).toHaveBeenCalled();
		expect(frame.data).toEqual([{ id: POST_KEY, title: 'read:hello' }]);
	});

	it('delivers an update through the real read path with the read hook applied', async () => {
		const messenger = getMessenger();
		const registry = new SubscriptionRegistry();

		readHook = vi.fn(async (rows: PostRow[]) => rows.map((row) => ({ ...row, title: `read:${row.title}` })));
		emitter.onFilter('items.read', readHook as never);

		tracker.on.select('posts').response([{ id: POST_KEY, title: 'updated', uploaded_by: null }] satisfies PostRow[]);

		producer = new HookEventProducer(messenger);
		producer.register();

		coordinator = new DispatchCoordinator({
			registry,
			getSchema: async () => userSchema as never,
			messenger,
			closeConnection: vi.fn(),
			deliveryConcurrency: 5,
		});

		coordinator.start();

		const reservation = registry.reserve({ client: adminClient(), collection: 'posts', query: {} as Query });
		if (reservation.ok) reservation.reservation.activate();

		emitter.emitAction('items.update', { collection: 'posts', keys: [POST_KEY] }, CONTEXT);

		await vi.waitFor(() => expect(send).toHaveBeenCalled());

		const frame = JSON.parse(send.mock.calls[0]![1] as string);

		expect(frame).toMatchObject({ type: 'subscription', event: 'update' });
		expect(frame.data).toEqual([{ id: POST_KEY, title: 'read:updated', uploaded_by: null }]);
		expect(readHook).toHaveBeenCalled();
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
