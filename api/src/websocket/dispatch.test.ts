import type { Query } from '@cairncms/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketClient } from './controllers/base.js';

vi.mock('./config.js', () => ({
	SUBSCRIPTIONS_PER_CONNECTION: 100,
	SUBSCRIPTIONS_PER_PROCESS: 10_000,
	SOURCE_EVENT_QUEUE_COUNT: 3,
	SOURCE_EVENT_QUEUE_BYTES: 100_000,
	OUTBOUND_FRAME_CAP: 1_048_576,
	OUTBOUND_QUEUE_BYTES: 1_048_576,
	DELIVERY_CONCURRENCY: 5,
}));

vi.mock('./target.js', () => ({ resolveTargetService: vi.fn() }));
vi.mock('./utils/items.js', () => ({ getEventPayload: vi.fn() }));

vi.mock('./utils/message.js', () => ({
	fmtMessage: (type: string, data: Record<string, unknown>, uid?: string) => JSON.stringify({ type, ...data, uid }),
	safeSend: vi.fn(() => ({ accepted: true })),
}));

vi.mock('../database/index.js', () => ({ getDatabaseClient: vi.fn(() => 'postgres') }));

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn() },
}));

const { DispatchCoordinator, resolveDeliveryConcurrency } = await import('./dispatch.js');
const { SubscriptionRegistry } = await import('./subscriptions.js');
const { getDatabaseClient } = await import('../database/index.js');
const { resolveTargetService } = await import('./target.js');
const { getEventPayload } = await import('./utils/items.js');
const { safeSend } = await import('./utils/message.js');
const logger = (await import('../logger.js')).default;

const resolveTarget = vi.mocked(resolveTargetService);
const eventPayload = vi.mocked(getEventPayload);
const send = vi.mocked(safeSend);
const dbClient = vi.mocked(getDatabaseClient);

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
	let resolve!: (value: T) => void;

	const promise = new Promise<T>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

let registry: InstanceType<typeof SubscriptionRegistry>;
let messengerCallback: ((message: Record<string, any>) => void) | null;
let closeConnection: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let coordinator: InstanceType<typeof DispatchCoordinator>;

function build(deliveryConcurrency = 5, getSchema: () => Promise<any> = async () => ({ collections: {} })) {
	unsubscribe = vi.fn();

	const messenger = {
		subscribe: (_channel: string, cb: (message: Record<string, any>) => void) => {
			messengerCallback = cb;
		},
		unsubscribe,
		publish: vi.fn(),
		getStatus: vi.fn(),
	} as never;

	closeConnection = vi.fn();

	coordinator = new DispatchCoordinator({
		registry,
		getSchema,
		messenger,
		closeConnection,
		deliveryConcurrency,
	});

	coordinator.start();
}

function emit(event: Record<string, unknown>): void {
	messengerCallback!(event);
}

function client(): SocketClient {
	return {
		stopping: false,
		auth: { snapshotAccountability: vi.fn().mockResolvedValue({ user: 'u', role: 'r', admin: false, app: true }) },
	} as unknown as SocketClient;
}

function clientWith(accountability: Record<string, unknown> | null): SocketClient {
	return {
		stopping: false,
		auth: { snapshotAccountability: vi.fn().mockResolvedValue(accountability) },
	} as unknown as SocketClient;
}

const ARTICLES_SCHEMA = async () => ({ collections: { articles: { primary: 'id' } } } as never);

function subscribe(c: SocketClient, collection: string, extra: Record<string, unknown> = {}) {
	const result = registry.reserve({ client: c, collection, query: {} as Query, ...extra });
	if (!result.ok) throw new Error('reserve refused');
	result.reservation.activate();
	return result.reservation;
}

function sentFrames() {
	return send.mock.calls.map((call) => JSON.parse(call[1] as string));
}

async function waitForRecovery() {
	await vi.waitFor(() => {
		const probe = registry.reserve({ client: client(), collection: 'probe', query: {} as Query });
		if (!probe.ok) throw new Error('still unavailable');
		probe.reservation.remove();
	});
}

beforeEach(() => {
	registry = new SubscriptionRegistry();
	messengerCallback = null;
	resolveTarget.mockReset();
	resolveTarget.mockReturnValue({} as never);
	eventPayload.mockReset();
	eventPayload.mockResolvedValue({ event: 'create', data: [{ id: 1 }] });
	send.mockClear();
	send.mockReturnValue({ accepted: true });
	dbClient.mockReturnValue('postgres');
	vi.mocked(logger.warn).mockClear();
	vi.mocked(logger.debug).mockClear();
	vi.mocked(logger.error).mockClear();
	vi.mocked(logger.info).mockClear();
	vi.mocked(logger.trace).mockClear();
});

afterEach(async () => {
	await coordinator?.stop();
});

describe('resolveDeliveryConcurrency', () => {
	it('is 1 for sqlite and the constant otherwise', () => {
		dbClient.mockReturnValue('sqlite');
		expect(resolveDeliveryConcurrency({} as never)).toBe(1);
		dbClient.mockReturnValue('postgres');
		expect(resolveDeliveryConcurrency({} as never)).toBe(5);
	});
});

describe('DispatchCoordinator delivery', () => {
	it('delivers a create event to a matching subscriber', async () => {
		build();
		subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalled());

		expect(sentFrames()[0]).toMatchObject({ type: 'subscription', event: 'create', data: [{ id: 1 }] });
	});

	it('iterates all subscribers and continues past an empty result', async () => {
		build();
		subscribe(client(), 'articles');
		subscribe(client(), 'articles');
		eventPayload.mockResolvedValueOnce({ event: 'create', data: [] });
		eventPayload.mockResolvedValueOnce({ event: 'create', data: [{ id: 2 }] });

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		expect(eventPayload).toHaveBeenCalledTimes(2);
		expect(sentFrames()[0]).toMatchObject({ data: [{ id: 2 }] });
	});

	it('delivers no delete to a subscription that did not opt in', async () => {
		build(5, ARTICLES_SCHEMA);
		subscribe(clientWith({ admin: true }), 'articles');
		subscribe(clientWith({ admin: true }), 'articles', { event: 'create' });

		emit({ action: 'delete', collection: 'articles', keys: [1] });
		await flush();
		await flush();

		expect(send).not.toHaveBeenCalled();
	});

	it('skips a non-matching event filter and a non-matching item scope', async () => {
		build();
		subscribe(client(), 'articles', { event: 'update' });
		subscribe(client(), 'articles', { item: '9' });

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		await flush();

		expect(send).not.toHaveBeenCalled();
	});

	it('delivers to an item subscriber when the event key matches canonically', async () => {
		build();
		subscribe(client(), 'articles', { item: '1' });

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});

	it('delivers a batch update to an item subscriber and forwards the item scope to the read', async () => {
		build();
		subscribe(client(), 'articles', { item: '1' });
		eventPayload.mockResolvedValue({ event: 'update', data: [{ id: 1 }] });

		emit({ action: 'update', collection: 'articles', keys: [1, 2] });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		const call = eventPayload.mock.calls[0]!;
		expect((call[1] as { item?: string }).item).toBe('1');
		expect(call[4]).toMatchObject({ action: 'update', keys: [1, 2] });
	});

	it('suppresses a subscriber whose accountability snapshot is null and continues', async () => {
		build();
		const suppressed = client();
		(suppressed.auth.snapshotAccountability as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		subscribe(suppressed, 'articles');
		subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});

	it('contains one subscriber thrown read without stopping the others', async () => {
		build();
		subscribe(client(), 'articles');
		subscribe(client(), 'articles');
		eventPayload.mockRejectedValueOnce(new Error('boom'));

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});

	it('does not log the contents of a failed read', async () => {
		build();
		subscribe(client(), 'articles');
		const secret = 'super-secret-token-abcdef';
		eventPayload.mockRejectedValueOnce(new Error(secret));

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		await flush();

		const logged = [logger.warn, logger.debug, logger.error, logger.info, logger.trace]
			.flatMap((fn) => vi.mocked(fn).mock.calls)
			.map((args) => JSON.stringify(args))
			.join(' ');

		expect(logged).not.toContain(secret);
	});

	it('resolves the schema once per event', async () => {
		const getSchema = vi.fn().mockResolvedValue({ collections: {} });
		build(5, getSchema);
		subscribe(client(), 'articles');
		subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

		expect(getSchema).toHaveBeenCalledTimes(1);
	});

	it('routes a guarded-send close to closeConnection with the client', async () => {
		build();
		const c = client();
		subscribe(c, 'articles');

		send.mockImplementationOnce((_client, _message, _limits, onClose) => {
			onClose?.(1009);
			return { accepted: false } as never;
		});

		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(closeConnection).toHaveBeenCalledWith(c, 1009));
	});
});

describe('DispatchCoordinator delete feed', () => {
	it('delivers a collection delete feed to an unconditional subscriber without a read', async () => {
		build(5, ARTICLES_SCHEMA);
		subscribe(clientWith({ admin: true }), 'articles', { event: 'delete' });

		emit({ action: 'delete', collection: 'articles', keys: [1, 2] });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		expect(sentFrames()[0]).toMatchObject({ event: 'delete', data: [1, 2] });
		expect(eventPayload).not.toHaveBeenCalled();
	});

	it('delivers only the subscribed key to an exact-item delete feed', async () => {
		build(5, ARTICLES_SCHEMA);
		subscribe(clientWith({ admin: true }), 'articles', { event: 'delete', item: '1' });

		emit({ action: 'delete', collection: 'articles', keys: [1, 2] });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		expect(sentFrames()[0]).toMatchObject({ event: 'delete', data: [1] });
	});

	it('sends nothing to a delete feed whose subscriber is not eligible at dispatch', async () => {
		build(5, ARTICLES_SCHEMA);
		subscribe(clientWith({ admin: false, permissions: [] }), 'articles', { event: 'delete' });

		emit({ action: 'delete', collection: 'articles', keys: [1] });
		await flush();
		await flush();

		expect(send).not.toHaveBeenCalled();
	});

	it('silently removes a delete feed whose eligibility was lost, delivering only to the eligible peer', async () => {
		build(5, ARTICLES_SCHEMA);
		const revoked = clientWith({ admin: true });
		const peer = clientWith({ admin: true });
		const reservation = subscribe(revoked, 'articles', { event: 'delete' });
		subscribe(peer, 'articles', { event: 'delete' });

		(revoked.auth.snapshotAccountability as ReturnType<typeof vi.fn>).mockResolvedValue({
			admin: false,
			permissions: [],
		});

		emit({ action: 'delete', collection: 'articles', keys: [1] });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		expect(reservation.isActive()).toBe(false);
		expect(closeConnection).not.toHaveBeenCalled();
		expect(send.mock.calls[0]![0]).toBe(peer);
		expect(send.mock.calls.some((call) => call[0] === revoked)).toBe(false);
		expect(sentFrames()[0]).toMatchObject({ event: 'delete', data: [1] });
	});
});

describe('DispatchCoordinator ordering and cutoff', () => {
	it('holds an event behind an initializing subscription until it activates', async () => {
		build();
		const result = registry.reserve({ client: client(), collection: 'articles', query: {} as Query });
		if (!result.ok) throw new Error('reserve refused');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		await flush();
		expect(send).not.toHaveBeenCalled();

		result.reservation.activate();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});

	it('excludes a subscription reserved after the event was captured', async () => {
		build();
		subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		subscribe(client(), 'articles');

		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('skips a subscription removed while an earlier delivery is in flight', async () => {
		build();
		const gate = deferred<{ event: string; data: unknown[] }>();
		eventPayload.mockReturnValueOnce(gate.promise);

		subscribe(client(), 'articles');
		const b = subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		await flush();

		b.remove();

		gate.resolve({ event: 'create', data: [{ id: 1 }] });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('releases the delivery slot when schema resolution fails so the next event delivers', async () => {
		const getSchema = vi.fn().mockRejectedValueOnce(new Error('schema down')).mockResolvedValue({ collections: {} });

		build(1, getSchema);
		subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		await flush();
		expect(send).not.toHaveBeenCalled();

		emit({ action: 'create', collection: 'articles', key: 2 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});
});

describe('DispatchCoordinator concurrency', () => {
	function gatedPayload() {
		let active = 0;
		let maxActive = 0;
		const gates: Array<() => void> = [];

		eventPayload.mockImplementation(() => {
			active++;
			maxActive = Math.max(maxActive, active);

			return new Promise((resolve) => {
				gates.push(() => {
					active--;
					resolve({ event: 'create', data: [{ id: 1 }] });
				});
			});
		});

		return { gates, peak: () => maxActive };
	}

	it('runs cross-collection deliveries concurrently up to the injected concurrency', async () => {
		build(2);
		subscribe(client(), 'articles');
		subscribe(client(), 'authors');
		const meter = gatedPayload();

		emit({ action: 'create', collection: 'articles', key: 1 });
		emit({ action: 'create', collection: 'authors', key: 1 });

		await vi.waitFor(() => expect(meter.gates.length).toBe(2));
		expect(meter.peak()).toBe(2);

		meter.gates.forEach((release) => release());
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
	});

	it('serializes cross-collection deliveries when concurrency is one', async () => {
		build(1);
		subscribe(client(), 'articles');
		subscribe(client(), 'authors');
		const meter = gatedPayload();

		emit({ action: 'create', collection: 'articles', key: 1 });
		emit({ action: 'create', collection: 'authors', key: 1 });

		await vi.waitFor(() => expect(meter.gates.length).toBe(1));
		expect(meter.peak()).toBe(1);

		meter.gates[0]!();
		await vi.waitFor(() => expect(meter.gates.length).toBe(2));
		meter.gates[1]!();

		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		expect(meter.peak()).toBe(1);
	});
});

describe('DispatchCoordinator overload', () => {
	it('admits up to the count bound and enters overload on the next event', async () => {
		build();
		const owner = client();
		const gate = deferred<{ event: string; data: unknown[] }>();
		eventPayload.mockReturnValue(gate.promise);
		subscribe(owner, 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		emit({ action: 'create', collection: 'articles', key: 2 });
		emit({ action: 'create', collection: 'articles', key: 3 });
		expect(closeConnection).not.toHaveBeenCalled();

		emit({ action: 'create', collection: 'articles', key: 4 });
		expect(closeConnection).toHaveBeenCalledWith(owner, 1013);

		expect(registry.reserve({ client: client(), collection: 'articles', query: {} as Query })).toEqual({
			ok: false,
			reason: 'unavailable',
		});

		gate.resolve({ event: 'create', data: [{ id: 1 }] });
		await waitForRecovery();
	});

	it('recovers from a single oversized event with no in-flight work and delivers afterward', async () => {
		build();
		const owner = client();
		subscribe(owner, 'articles');

		emit({ action: 'create', collection: 'articles', key: 'x'.repeat(200_000) });

		expect(closeConnection).toHaveBeenCalledWith(owner, 1013);

		await waitForRecovery();
		registry.removeAllForClient(owner);
		send.mockClear();

		subscribe(client(), 'articles');
		emit({ action: 'create', collection: 'articles', key: 1 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});

	it('dispatches a fresh event through a new token after recovering from overload', async () => {
		build();
		const owner = client();
		const gate = deferred<{ event: string; data: unknown[] }>();
		eventPayload.mockReturnValueOnce(gate.promise);
		subscribe(owner, 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		emit({ action: 'create', collection: 'articles', key: 2 });
		emit({ action: 'create', collection: 'articles', key: 3 });
		emit({ action: 'create', collection: 'articles', key: 4 });

		expect(closeConnection).toHaveBeenCalledWith(owner, 1013);

		gate.resolve({ event: 'create', data: [{ id: 1 }] });
		await waitForRecovery();

		registry.removeAllForClient(owner);
		send.mockClear();
		eventPayload.mockResolvedValue({ event: 'create', data: [{ id: 9 }] });

		subscribe(client(), 'articles');
		emit({ action: 'create', collection: 'articles', key: 9 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(sentFrames()[0]).toMatchObject({ data: [{ id: 9 }] });
	});

	it('admits an event at the byte bound and enters overload one byte over it', async () => {
		build();
		const owner = client();
		subscribe(owner, 'articles');
		const overhead = Buffer.from(JSON.stringify({ action: 'create', collection: 'articles', key: '' })).length;

		emit({ action: 'create', collection: 'articles', key: 'x'.repeat(100_000 - overhead) });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(closeConnection).not.toHaveBeenCalled();

		emit({ action: 'create', collection: 'articles', key: 'x'.repeat(100_001 - overhead) });
		expect(closeConnection).toHaveBeenCalledWith(owner, 1013);
	});

	it('does no read or send for an event canceled while awaiting a delivery slot', async () => {
		build(1);
		const owner = client();
		const waiting = client();
		subscribe(owner, 'articles');
		subscribe(waiting, 'authors');

		const gate = deferred<{ event: string; data: unknown[] }>();
		eventPayload.mockReturnValueOnce(gate.promise);
		eventPayload.mockResolvedValue({ event: 'create', data: [{ id: 1 }] });

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();
		emit({ action: 'create', collection: 'authors', key: 1 });
		await flush();

		emit({ action: 'create', collection: 'articles', key: 2 });
		emit({ action: 'create', collection: 'articles', key: 3 });

		expect(closeConnection).toHaveBeenCalledWith(owner, 1013);
		expect(closeConnection).toHaveBeenCalledWith(waiting, 1013);

		const authorReads = () =>
			eventPayload.mock.calls.filter((call) => (call[4] as { collection: string }).collection === 'authors');

		expect(authorReads()).toHaveLength(0);

		gate.resolve({ event: 'create', data: [{ id: 1 }] });
		await waitForRecovery();

		expect(authorReads()).toHaveLength(0);
		expect(send.mock.calls.filter((call) => call[0] === waiting)).toHaveLength(0);

		send.mockClear();
		subscribe(client(), 'articles');
		emit({ action: 'create', collection: 'articles', key: 9 });
		await vi.waitFor(() => expect(send).toHaveBeenCalled());
	});
});

describe('DispatchCoordinator shutdown', () => {
	it('unsubscribes the exact callback and marks the registry unavailable', async () => {
		build();
		await coordinator.stop();

		expect(unsubscribe).toHaveBeenCalledWith('websocket.event', expect.any(Function));

		expect(registry.reserve({ client: client(), collection: 'articles', query: {} as Query })).toEqual({
			ok: false,
			reason: 'unavailable',
		});
	});

	it('shares one completion across concurrent stop calls that await a stalled delivery', async () => {
		build();
		const gate = deferred<{ event: string; data: unknown[] }>();
		eventPayload.mockReturnValue(gate.promise);
		subscribe(client(), 'articles');

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();

		const first = coordinator.stop();
		const second = coordinator.stop();

		let firstDone = false;
		let secondDone = false;

		void first.then(() => {
			firstDone = true;
		});

		void second.then(() => {
			secondDone = true;
		});

		await flush();
		expect(firstDone).toBe(false);
		expect(secondDone).toBe(false);

		gate.resolve({ event: 'create', data: [{ id: 1 }] });
		await first;
		await second;
		expect(firstDone).toBe(true);
		expect(secondDone).toBe(true);
	});

	it('cancels a never-settling barrier on stop without waiting for it', async () => {
		build();
		const c = client();
		registry.reserve({ client: c, collection: 'articles', query: {} as Query });

		emit({ action: 'create', collection: 'articles', key: 1 });
		await flush();

		await expect(coordinator.stop()).resolves.toBeUndefined();
	});
});
