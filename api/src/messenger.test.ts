import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSENGER_CONFIG_INVALID, MESSENGER_RECOVERED, MESSENGER_UNAVAILABLE } from './messenger.js';

type Listener = (...args: unknown[]) => void;

const hoisted = vi.hoisted(() => ({
	env: {} as Record<string, unknown>,
	instances: [] as Array<{
		publish: ReturnType<typeof vi.fn>;
		subscribe: ReturnType<typeof vi.fn>;
		unsubscribe: ReturnType<typeof vi.fn>;
		disconnect: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		emit: (event: string, ...args: unknown[]) => void;
	}>,
	constructorArgs: [] as unknown[][],
	constructThrowOn: null as number | null,
	publishImpl: ((..._args: unknown[]) => Promise.resolve(1)) as (...args: unknown[]) => Promise<unknown>,
	subscribeImpl: ((..._args: unknown[]) => Promise.resolve(1)) as (...args: unknown[]) => Promise<unknown>,
	unsubscribeImpl: ((..._args: unknown[]) => Promise.resolve(1)) as (...args: unknown[]) => Promise<unknown>,
	disconnectImpl: ((..._args: unknown[]) => undefined) as (...args: unknown[]) => void,
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => hoisted.env[prop as string] }),
	getEnv: () => hoisted.env,
}));

vi.mock('./logger.js', () => ({ default: hoisted.logger }));

vi.mock('ioredis', () => ({
	Redis: class {
		listeners: Record<string, Listener[]> = {};
		publish = vi.fn((...args: unknown[]) => hoisted.publishImpl(...args));
		subscribe = vi.fn((...args: unknown[]) => hoisted.subscribeImpl(...args));
		unsubscribe = vi.fn((...args: unknown[]) => hoisted.unsubscribeImpl(...args));
		disconnect = vi.fn((...args: unknown[]) => hoisted.disconnectImpl(...args));

		on = vi.fn((event: string, callback: Listener) => {
			(this.listeners[event] ??= []).push(callback);
			return this;
		});

		emit(event: string, ...args: unknown[]) {
			for (const callback of this.listeners[event] ?? []) callback(...args);
		}

		constructor(...args: unknown[]) {
			hoisted.constructorArgs.push(args);

			if (hoisted.constructThrowOn !== null && hoisted.constructorArgs.length === hoisted.constructThrowOn) {
				throw new Error('URI malformed');
			}

			hoisted.instances.push(this as never);
		}
	},
}));

beforeEach(() => {
	vi.useFakeTimers();
	for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
	hoisted.instances.length = 0;
	hoisted.constructorArgs.length = 0;
	hoisted.constructThrowOn = null;
	hoisted.publishImpl = () => Promise.resolve(1);
	hoisted.subscribeImpl = () => Promise.resolve(1);
	hoisted.unsubscribeImpl = () => Promise.resolve(1);
	hoisted.disconnectImpl = () => undefined;
	hoisted.logger.info.mockClear();
	hoisted.logger.warn.mockClear();
	hoisted.logger.error.mockClear();
	vi.resetModules();
});

afterEach(() => {
	vi.useRealTimers();
});

function enableRedis(overrides: Record<string, unknown> = {}) {
	hoisted.env['MESSENGER_STORE'] = 'redis';
	hoisted.env['MESSENGER_REDIS'] = 'redis://localhost:6379/0';
	Object.assign(hoisted.env, overrides);
}

function pubClient() {
	return hoisted.instances[0]!;
}

function subClient() {
	return hoisted.instances[1]!;
}

async function flush() {
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(0);
}

async function bringUp() {
	subClient().emit('ready');
	await flush();
	pubClient().emit('ready');
	await flush();
}

function deferred() {
	let resolve!: (value?: unknown) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

describe('construction', () => {
	it('builds a publisher and a subscriber with fail-closed options and manual resubscription', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');

		getMessenger();

		expect(hoisted.constructorArgs).toHaveLength(2);
		const [url, options] = hoisted.constructorArgs[0] as [string, Record<string, unknown>];
		expect(url).toBe('redis://localhost:6379/0');

		expect(options).toMatchObject({
			enableOfflineQueue: false,
			autoResendUnfulfilledCommands: false,
			maxRetriesPerRequest: 0,
			autoResubscribe: false,
		});
	});

	it('attaches a swallowing error listener to each client', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');

		getMessenger();

		for (const client of [pubClient(), subClient()]) {
			const call = client.on.mock.calls.find(([event]) => event === 'error');
			expect(call).toBeDefined();
			expect(() => (call![1] as (error: Error) => void)(new Error('connect ECONNREFUSED'))).not.toThrow();
		}
	});

	it('installs exactly one message dispatcher on the subscriber', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		messenger.subscribe('schemaChanged', () => undefined);

		const messageListeners = subClient().on.mock.calls.filter(([event]) => event === 'message');
		expect(messageListeners).toHaveLength(1);
	});

	it('routes an incoming message to the channel callback', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();
		const received: Array<Record<string, any>> = [];

		messenger.subscribe('flows', (payload) => received.push(payload));
		subClient().emit('message', 'cairncms:flows', JSON.stringify({ type: 'reload' }));

		expect(received).toEqual([{ type: 'reload' }]);
	});

	it('fails soft with no-op methods when a client cannot be constructed', async () => {
		enableRedis();
		hoisted.constructThrowOn = 1;
		const { getMessenger } = await import('./messenger.js');

		let messenger!: ReturnType<typeof getMessenger>;

		expect(() => {
			messenger = getMessenger();
		}).not.toThrow();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_CONFIG_INVALID);

		expect(() => messenger.publish('flows', {})).not.toThrow();
		expect(() => messenger.subscribe('flows', () => undefined)).not.toThrow();
		expect(() => messenger.unsubscribe('flows')).not.toThrow();
	});

	it('disconnects a partially constructed client when the second fails', async () => {
		enableRedis();
		hoisted.constructThrowOn = 2;
		const { getMessenger } = await import('./messenger.js');

		getMessenger();

		expect(hoisted.instances).toHaveLength(1);
		expect(hoisted.instances[0]!.disconnect).toHaveBeenCalled();
	});

	it('stays fail-soft with only the fixed warning when partial cleanup throws', async () => {
		enableRedis();
		hoisted.constructThrowOn = 2;

		hoisted.disconnectImpl = () => {
			throw new Error('disconnect failed');
		};

		const { getMessenger } = await import('./messenger.js');

		let messenger!: ReturnType<typeof getMessenger>;

		expect(() => {
			messenger = getMessenger();
		}).not.toThrow();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_CONFIG_INVALID);
		expect(hoisted.logger.info).not.toHaveBeenCalled();
		expect(hoisted.logger.error).not.toHaveBeenCalled();
	});
});

describe('subscription registry', () => {
	it('retains a subscribe issued before ready and resubscribes on ready', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		expect(subClient().subscribe).not.toHaveBeenCalled();

		subClient().emit('ready');
		await flush();

		expect(subClient().subscribe).toHaveBeenCalledWith('cairncms:flows');
	});

	it('resubscribes every desired channel on ready', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		messenger.subscribe('schemaChanged', () => undefined);

		subClient().emit('ready');
		await flush();

		expect(subClient().subscribe).toHaveBeenCalledWith('cairncms:flows');
		expect(subClient().subscribe).toHaveBeenCalledWith('cairncms:schemaChanged');
	});

	it('does not resubscribe a channel unsubscribed before ready', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		messenger.unsubscribe('flows');

		subClient().emit('ready');
		await flush();

		expect(subClient().subscribe).not.toHaveBeenCalledWith('cairncms:flows');
	});

	it('publishes on the namespaced channel with a JSON payload', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		messenger.publish('flows', { type: 'reload' });
		await flush();

		expect(pubClient().publish).toHaveBeenCalledWith('cairncms:flows', JSON.stringify({ type: 'reload' }));
	});

	it('adds a subscription after readiness without logging a degradation', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.logger.warn.mockClear();
		hoisted.logger.info.mockClear();

		messenger.subscribe('flows', () => undefined);
		await flush();

		expect(messenger.getStatus()).toBe('available');
		expect(subClient().subscribe).toHaveBeenCalledWith('cairncms:flows');
		expect(hoisted.logger.warn).not.toHaveBeenCalled();
		expect(hoisted.logger.info).not.toHaveBeenCalled();
	});

	it('reports unavailable without logging while a subscribe is in flight, then recovers silently', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.logger.warn.mockClear();
		hoisted.logger.info.mockClear();

		const pending = deferred();
		hoisted.subscribeImpl = () => pending.promise;

		messenger.subscribe('flows', () => undefined);
		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).not.toHaveBeenCalled();

		pending.resolve(1);
		await flush();

		expect(messenger.getStatus()).toBe('available');
		expect(hoisted.logger.warn).not.toHaveBeenCalled();
		expect(hoisted.logger.info).not.toHaveBeenCalled();
	});
});

describe('status and transition logging', () => {
	it('reaches available on ready without logging the first connection', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		expect(messenger.getStatus()).toBe('unavailable');

		await bringUp();

		expect(messenger.getStatus()).toBe('available');
		expect(hoisted.logger.warn).not.toHaveBeenCalled();
		expect(hoisted.logger.info).not.toHaveBeenCalled();
	});

	it('logs the unavailable and recovered transitions once each', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();

		subClient().emit('close');
		pubClient().emit('close');
		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_UNAVAILABLE);

		await bringUp();

		expect(messenger.getStatus()).toBe('available');
		expect(hoisted.logger.info).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.info).toHaveBeenCalledWith(MESSENGER_RECOVERED);
	});

	it('keeps the transition message free of Redis diagnostics', () => {
		expect(MESSENGER_UNAVAILABLE).not.toMatch(/redis|ioredis|econn|noperm/i);
		expect(MESSENGER_RECOVERED).not.toMatch(/redis|ioredis|econn|noperm/i);
	});

	it('logs one warning when the initial connection fails', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		pubClient().emit('error', new Error('connect ECONNREFUSED'));
		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_UNAVAILABLE);

		pubClient().emit('error', new Error('connect ECONNREFUSED'));
		subClient().emit('error', new Error('connect ECONNREFUSED'));
		await flush();

		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
	});

	it('logs one warning when the publisher is denied at startup', async () => {
		enableRedis();
		hoisted.publishImpl = () => Promise.reject(new Error('NOPERM'));
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		subClient().emit('ready');
		await flush();
		pubClient().emit('ready');
		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_UNAVAILABLE);
	});
});

describe('publisher failure', () => {
	it('catches a failed publish, transitions unavailable, and logs one warning', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.logger.warn.mockClear();
		hoisted.publishImpl = () => Promise.reject(new Error('NOPERM publish denied'));

		messenger.publish('flows', { type: 'reload' });
		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_UNAVAILABLE);
	});

	it('logs one unavailable record for many rejected publishes in a single outage', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.logger.warn.mockClear();
		hoisted.publishImpl = () => Promise.reject(new Error('down'));

		for (let attempt = 0; attempt < 5; attempt++) messenger.publish('flows', { attempt });

		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
	});

	it('clears publisher failure only through a publish or probe, never subscriber reconciliation', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		hoisted.publishImpl = () => Promise.reject(new Error('down'));
		messenger.publish('flows', { type: 'reload' });
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		await vi.advanceTimersByTimeAsync(3_000);
		expect(messenger.getStatus()).toBe('unavailable');

		hoisted.publishImpl = () => Promise.resolve(1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(messenger.getStatus()).toBe('available');
	});

	it('probes the publisher with an empty payload on the dedicated channel', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');

		getMessenger();
		await bringUp();

		expect(pubClient().publish).toHaveBeenCalledWith('cairncms:messenger-probe', '');
	});

	it('keeps the publisher unavailable while PUBLISH is denied even though the socket is ready', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.publishImpl = () => Promise.reject(new Error('NOPERM'));
		messenger.publish('flows', {});
		await flush();

		await vi.advanceTimersByTimeAsync(3_000);
		expect(messenger.getStatus()).toBe('unavailable');
	});
});

describe('independent client health', () => {
	it('recovers a publisher-only outage without resubscribing the subscriber', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		subClient().subscribe.mockClear();
		pubClient().emit('close');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		pubClient().emit('ready');
		await flush();

		expect(messenger.getStatus()).toBe('available');
		expect(subClient().subscribe).not.toHaveBeenCalled();
	});

	it('reconciles the subscriber on its own reconnect after a subscriber-only outage', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		subClient().subscribe.mockClear();
		subClient().emit('close');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		subClient().emit('ready');
		await flush();

		expect(subClient().subscribe).toHaveBeenCalledWith('cairncms:flows');
		expect(messenger.getStatus()).toBe('available');
	});

	it('schedules no recovery while one client stays disconnected and the other is healthy', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		subClient().subscribe.mockClear();
		pubClient().publish.mockClear();

		pubClient().emit('close');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		await vi.advanceTimersByTimeAsync(10_000);

		expect(vi.getTimerCount()).toBe(0);
		expect(subClient().subscribe).not.toHaveBeenCalled();
		expect(pubClient().publish).not.toHaveBeenCalled();

		pubClient().emit('ready');
		await flush();

		expect(pubClient().publish).toHaveBeenCalledWith('cairncms:messenger-probe', '');
		expect(messenger.getStatus()).toBe('available');
	});
});

describe('command deadline recycle', () => {
	it('recycles a client whose command stalls past the deadline and transitions once', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.logger.warn.mockClear();

		const hang = deferred();
		hoisted.publishImpl = () => hang.promise;

		messenger.publish('flows', { type: 'reload' });
		await vi.advanceTimersByTimeAsync(5_000);

		expect(pubClient().disconnect).toHaveBeenCalledWith(true);
		expect(messenger.getStatus()).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
	});

	it('flushes staggered stalled commands with a single generation-owned recycle', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();

		const rejecters: Array<(reason: unknown) => void> = [];
		hoisted.publishImpl = () => new Promise((_resolve, reject) => rejecters.push(reject));

		hoisted.disconnectImpl = () => {
			while (rejecters.length) rejecters.shift()!(new Error('Connection is closed'));
		};

		for (let second = 0; second < 3; second++) {
			messenger.publish('flows', { second });
			await vi.advanceTimersByTimeAsync(1_000);
		}

		await vi.advanceTimersByTimeAsync(5_000);

		expect(pubClient().disconnect).toHaveBeenCalledTimes(1);
		expect(pubClient().disconnect).toHaveBeenCalledWith(true);
	});

	it('discards a stalled probe so a superseded generation cannot restore health', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();

		hoisted.publishImpl = () => Promise.reject(new Error('down'));
		messenger.publish('flows', {});
		await flush();

		const hang = deferred();
		hoisted.publishImpl = () => hang.promise;
		await vi.advanceTimersByTimeAsync(50);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(pubClient().disconnect).toHaveBeenCalledWith(true);

		hang.resolve(1);
		await flush();

		expect(messenger.getStatus()).toBe('unavailable');
	});
});

describe('socket-ready command rejection recovery', () => {
	it('recovers a rejected subscribe by reconciling on the next attempt', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();

		let calls = 0;
		hoisted.subscribeImpl = () => (++calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve(1));

		messenger.subscribe('flows', () => undefined);
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		await vi.advanceTimersByTimeAsync(100);
		expect(messenger.getStatus()).toBe('available');
	});

	it('holds a failed unsubscribe in the pending-removal set and clears it on recovery', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		hoisted.unsubscribeImpl = () => Promise.reject(new Error('transient'));
		messenger.unsubscribe('flows');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		hoisted.unsubscribeImpl = () => Promise.resolve(1);
		subClient().subscribe.mockClear();

		await vi.advanceTimersByTimeAsync(200);

		expect(messenger.getStatus()).toBe('available');
		expect(subClient().subscribe).not.toHaveBeenCalledWith('cairncms:flows');
	});

	it('cancels a pending removal when the channel is resubscribed before recovery', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		hoisted.unsubscribeImpl = () => Promise.reject(new Error('transient'));
		messenger.unsubscribe('flows');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		const callback = vi.fn();
		messenger.subscribe('flows', callback);
		await flush();

		subClient().unsubscribe.mockClear();
		await vi.advanceTimersByTimeAsync(200);

		expect(subClient().unsubscribe).not.toHaveBeenCalled();
		expect(messenger.getStatus()).toBe('available');

		subClient().emit('message', 'cairncms:flows', JSON.stringify({ x: 1 }));
		expect(callback).toHaveBeenCalledWith({ x: 1 });
	});

	it('does not unsubscribe a channel re-desired while an earlier pending removal is in flight', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('a', () => undefined);
		const callbackB = vi.fn();
		messenger.subscribe('b', callbackB);
		await bringUp();

		hoisted.unsubscribeImpl = () => Promise.reject(new Error('transient'));
		messenger.unsubscribe('a');
		messenger.unsubscribe('b');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		const pending: Array<{ channel: string; resolve: () => void }> = [];

		hoisted.unsubscribeImpl = (channel) =>
			new Promise<void>((resolve) => pending.push({ channel: channel as string, resolve }));

		hoisted.subscribeImpl = () => Promise.resolve(1);
		subClient().unsubscribe.mockClear();

		await vi.advanceTimersByTimeAsync(100);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.channel).toBe('cairncms:a');

		messenger.subscribe('b', callbackB);
		await flush();

		pending.shift()!.resolve();
		await vi.advanceTimersByTimeAsync(200);

		expect(subClient().unsubscribe).not.toHaveBeenCalledWith('cairncms:b');
		expect(messenger.getStatus()).toBe('available');

		subClient().emit('message', 'cairncms:b', JSON.stringify({ x: 1 }));
		expect(callbackB).toHaveBeenCalledWith({ x: 1 });
	});
});

describe('recovery scheduler lifecycle', () => {
	it('preempts the backoff timer and reconciles immediately on ready', async () => {
		enableRedis();
		const { getMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		messenger.subscribe('flows', () => undefined);
		await bringUp();

		let failNext = true;
		hoisted.subscribeImpl = () => (failNext ? Promise.reject(new Error('transient')) : Promise.resolve(1));

		subClient().emit('close');
		await flush();
		subClient().emit('ready');
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		const beforePreempt = subClient().subscribe.mock.calls.length;
		failNext = false;
		subClient().emit('ready');
		await flush();

		expect(subClient().subscribe.mock.calls.length).toBeGreaterThan(beforePreempt);
		expect(messenger.getStatus()).toBe('available');
	});

	it('clears the recovery timer and issues no further probes after destroy', async () => {
		enableRedis();
		const { getMessenger, destroyMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.publishImpl = () => Promise.reject(new Error('down'));
		messenger.publish('flows', {});
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		pubClient().publish.mockClear();
		destroyMessenger();

		expect(pubClient().disconnect).toHaveBeenCalled();
		expect(subClient().disconnect).toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5_000);
		expect(pubClient().publish).not.toHaveBeenCalled();
	});

	it('keeps the destroyed messenger terminal and requires a module reload for a fresh instance', async () => {
		enableRedis();
		const first = await import('./messenger.js');
		const instance = first.getMessenger();

		first.destroyMessenger();
		expect(first.getMessenger()).toBe(instance);

		vi.resetModules();
		const second = await import('./messenger.js');
		expect(second.getMessenger()).not.toBe(instance);
	});

	it('invalidates in-flight work on destroy so a late completion cannot log recovery', async () => {
		enableRedis();
		const { getMessenger, destroyMessenger } = await import('./messenger.js');
		const messenger = getMessenger();

		await bringUp();
		hoisted.publishImpl = () => Promise.reject(new Error('down'));
		messenger.publish('flows', {});
		await flush();
		expect(messenger.getStatus()).toBe('unavailable');

		const hang = deferred();
		hoisted.publishImpl = () => hang.promise;
		await vi.advanceTimersByTimeAsync(50);

		hoisted.logger.info.mockClear();
		destroyMessenger();
		hang.resolve(1);
		await flush();

		expect(hoisted.logger.info).not.toHaveBeenCalled();
	});
});

describe('memory messenger', () => {
	it('reports the in-memory messenger as always available', async () => {
		hoisted.env['MESSENGER_STORE'] = 'local';
		const { getMessenger, getMessengerStatus } = await import('./messenger.js');

		expect(getMessenger().getStatus()).toBe('available');
		expect(getMessengerStatus()).toBe('available');
	});

	it('exposes the live redis status through getMessengerStatus', async () => {
		enableRedis();
		const { getMessenger, getMessengerStatus } = await import('./messenger.js');

		getMessenger();
		expect(getMessengerStatus()).toBe('unavailable');

		await bringUp();
		expect(getMessengerStatus()).toBe('available');
	});
});
