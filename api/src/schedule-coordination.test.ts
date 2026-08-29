import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SCHEDULE_COORDINATION_CONFIG_INVALID,
	SCHEDULE_COORDINATION_RECOVERED,
	SCHEDULE_COORDINATION_UNAVAILABLE,
} from './schedule-coordination.js';

type Listener = (...args: unknown[]) => void;

const hoisted = vi.hoisted(() => ({
	env: {} as Record<string, unknown>,
	instances: [] as Array<{
		zadd: ReturnType<typeof vi.fn>;
		disconnect: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		emit: (event: string, ...args: unknown[]) => void;
	}>,
	constructorArgs: [] as unknown[][],
	constructError: null as Error | null,
	zaddImpl: ((..._args: unknown[]) => Promise.resolve(1)) as (...args: unknown[]) => Promise<unknown>,
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
		zadd = vi.fn((...args: unknown[]) => hoisted.zaddImpl(...args));
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
			if (hoisted.constructError) throw hoisted.constructError;
			hoisted.instances.push(this as never);
		}
	},
}));

beforeEach(() => {
	vi.useFakeTimers();
	for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
	hoisted.instances.length = 0;
	hoisted.constructorArgs.length = 0;
	hoisted.constructError = null;
	hoisted.zaddImpl = () => Promise.resolve(1);
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

function client() {
	return hoisted.instances[hoisted.instances.length - 1]!;
}

async function flush() {
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(0);
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

function createStore() {
	const sets = new Map<string, Map<string, number>>();

	function zadd(key: string, ...args: unknown[]) {
		const gt = args.includes('GT');
		const member = String(args[args.length - 1]);
		const score = Number(args[args.length - 2]);
		const set = sets.get(key) ?? new Map<string, number>();
		sets.set(key, set);
		const existing = set.get(member);

		if (existing === undefined || (gt ? score > existing : score !== existing)) {
			set.set(member, score);
			return Promise.resolve(1);
		}

		return Promise.resolve(0);
	}

	return { sets, zadd };
}

async function initReady(overrides: Record<string, unknown> = {}) {
	enableRedis(overrides);
	const mod = await import('./schedule-coordination.js');
	const init = mod.initScheduleCoordination();
	client().emit('ready');
	await flush();
	await init;
	return mod;
}

describe('isCoordinationEnabled', () => {
	it('is false when the messenger is not redis', async () => {
		hoisted.env['MESSENGER_STORE'] = 'local';
		const { isCoordinationEnabled } = await import('./schedule-coordination.js');
		expect(isCoordinationEnabled()).toBe(false);
	});

	it('is true when the messenger is redis', async () => {
		hoisted.env['MESSENGER_STORE'] = 'redis';
		const { isCoordinationEnabled } = await import('./schedule-coordination.js');
		expect(isCoordinationEnabled()).toBe(true);
	});
});

describe('initScheduleCoordination', () => {
	it('builds no client when coordination is disabled', async () => {
		hoisted.env['MESSENGER_STORE'] = 'local';
		const { initScheduleCoordination } = await import('./schedule-coordination.js');

		await expect(initScheduleCoordination()).resolves.toBe('inactive');
		expect(hoisted.constructorArgs).toHaveLength(0);
	});

	it('builds one fail-closed client from a connection string', async () => {
		enableRedis();
		await initReady();

		const [url, options] = hoisted.constructorArgs[0] as [string, Record<string, unknown>];
		expect(url).toBe('redis://localhost:6379/0');

		expect(options).toMatchObject({
			enableOfflineQueue: false,
			autoResendUnfulfilledCommands: false,
			maxRetriesPerRequest: 0,
		});
	});

	it('builds one fail-closed client from individual connection params', async () => {
		enableRedis();
		delete hoisted.env['MESSENGER_REDIS'];
		hoisted.env['MESSENGER_REDIS_HOST'] = '127.0.0.1';
		hoisted.env['MESSENGER_REDIS_PORT'] = '6380';
		const { initScheduleCoordination } = await import('./schedule-coordination.js');

		const init = initScheduleCoordination();
		client().emit('ready');
		await flush();
		await init;

		const [config] = hoisted.constructorArgs[0] as [Record<string, unknown>];

		expect(config).toMatchObject({
			host: '127.0.0.1',
			enableOfflineQueue: false,
			autoResendUnfulfilledCommands: false,
			maxRetriesPerRequest: 0,
		});
	});

	it('attaches a swallowing error listener so ioredis never writes a stack to stderr', async () => {
		enableRedis();
		const { initScheduleCoordination } = await import('./schedule-coordination.js');
		initScheduleCoordination();

		const call = client().on.mock.calls.find(([event]) => event === 'error');
		expect(call).toBeDefined();
		expect(() => (call![1] as (error: Error) => void)(new Error('connect ECONNREFUSED'))).not.toThrow();
	});

	it('probes the claim key with a reserved member on ready', async () => {
		enableRedis();
		await initReady();

		expect(client().zadd).toHaveBeenCalledWith('cairncms:schedule-coordination', 'GT', 'CH', 0, '__probe__');
	});

	it('probes with a reserved member that does not disturb real schedule claims', async () => {
		enableRedis();
		const store = createStore();
		hoisted.zaddImpl = (...args) => store.zadd(args[0] as string, ...args.slice(1));
		const mod = await initReady();

		await mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000);

		const claimSet = store.sets.get('cairncms:schedule-coordination')!;
		expect(claimSet.get('__probe__')).toBe(0);
		expect(claimSet.get('flow-a')).toBe(Date.parse('2026-08-11T00:00:00.000Z'));
	});

	it('does not restore readiness while the claim key is denied even if another key would be writable', async () => {
		enableRedis();

		hoisted.zaddImpl = (key: string) =>
			key === 'cairncms:schedule-coordination' ? Promise.reject(new Error('NOPERM')) : Promise.resolve(1);

		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();

		await expect(init).resolves.toBe('unavailable');
		expect(client().zadd).toHaveBeenCalledWith('cairncms:schedule-coordination', 'GT', 'CH', 0, '__probe__');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');
	});

	it('resolves ready when the probe passes', async () => {
		enableRedis();
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();

		await expect(init).resolves.toBe('ready');
	});

	it('marks unavailable without disconnecting when the store lacks ZADD GT', async () => {
		enableRedis();
		hoisted.zaddImpl = () => Promise.reject(new Error('ERR syntax error'));
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();

		await expect(init).resolves.toBe('unavailable');
		expect(client().disconnect).not.toHaveBeenCalled();
	});

	it('resolves unavailable fast when the connection closes before readying', async () => {
		enableRedis();
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('close');
		await flush();

		await expect(init).resolves.toBe('unavailable');
	});

	it('resolves unavailable when no ready arrives within the readiness deadline', async () => {
		enableRedis();
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(init).resolves.toBe('unavailable');
		expect(hoisted.logger.error).toHaveBeenCalledTimes(1);
	});

	it('resolves unavailable without escaping startup when the client constructor throws', async () => {
		enableRedis();
		hoisted.constructError = new Error('URI malformed');
		const { initScheduleCoordination } = await import('./schedule-coordination.js');

		await expect(initScheduleCoordination()).resolves.toBe('unavailable');
		expect(hoisted.logger.error).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.error).toHaveBeenCalledWith(SCHEDULE_COORDINATION_CONFIG_INVALID);
	});

	it('recycles the connection when the probe stalls past the deadline', async () => {
		enableRedis();
		const pending = deferred();
		hoisted.zaddImpl = () => pending.promise;
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();

		await vi.advanceTimersByTimeAsync(5_000);

		await expect(init).resolves.toBe('unavailable');
		expect(client().disconnect).toHaveBeenCalledWith(true);
	});
});

describe('recovery', () => {
	it('recovers when a later ready probes a now-capable store', async () => {
		enableRedis();
		hoisted.zaddImpl = () => Promise.reject(new Error('ERR syntax error'));
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();
		await expect(init).resolves.toBe('unavailable');

		hoisted.zaddImpl = () => Promise.resolve(1);
		client().emit('close');
		await flush();
		client().emit('ready');
		await flush();

		expect(mod.getScheduleCoordinationStatus()).toBe('ready');

		const admitted = await mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000);
		expect(admitted).toBe(true);
	});

	it('logs one error on the outage and one info on recovery', async () => {
		const mod = await initReady();
		hoisted.logger.error.mockClear();
		hoisted.logger.info.mockClear();

		client().emit('close');
		client().emit('close');
		await flush();
		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');
		expect(hoisted.logger.error).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.error).toHaveBeenCalledWith(SCHEDULE_COORDINATION_UNAVAILABLE);

		client().emit('ready');
		await flush();
		expect(mod.getScheduleCoordinationStatus()).toBe('ready');
		expect(hoisted.logger.info).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.info).toHaveBeenCalledWith(SCHEDULE_COORDINATION_RECOVERED);
	});

	it('suppresses claims while unavailable and resumes once ready', async () => {
		enableRedis();
		hoisted.zaddImpl = () => Promise.reject(new Error('ERR syntax error'));
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();
		await init;

		client().zadd.mockClear();

		await expect(mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000)).resolves.toBe(
			false
		);

		expect(client().zadd).not.toHaveBeenCalled();

		hoisted.zaddImpl = () => Promise.resolve(1);
		client().emit('close');
		await flush();
		client().emit('ready');
		await flush();

		await expect(mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000)).resolves.toBe(
			true
		);
	});

	it('discards a probe that resolves after the connection dropped', async () => {
		enableRedis();
		const pending = deferred();
		hoisted.zaddImpl = () => pending.promise;
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();

		client().emit('close');
		await flush();
		await expect(init).resolves.toBe('unavailable');

		pending.resolve(1);
		await flush();

		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');
	});

	it('recovers a socket-ready probe rejection through the backed-off scheduler', async () => {
		enableRedis();
		let deny = true;
		hoisted.zaddImpl = () => (deny ? Promise.reject(new Error('NOPERM')) : Promise.resolve(1));
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();
		await expect(init).resolves.toBe('unavailable');
		expect(client().disconnect).not.toHaveBeenCalled();

		deny = false;
		await vi.advanceTimersByTimeAsync(100);

		expect(mod.getScheduleCoordinationStatus()).toBe('ready');
		expect(hoisted.logger.info).toHaveBeenCalledTimes(1);
	});

	it('transitions unavailable on a socket-ready claim rejection and recovers', async () => {
		const mod = await initReady();
		hoisted.logger.error.mockClear();
		hoisted.logger.info.mockClear();

		hoisted.zaddImpl = () => Promise.reject(new Error('READONLY'));

		await expect(
			mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000)
		).rejects.toBeInstanceOf(mod.ScheduleCoordinationError);

		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');
		expect(hoisted.logger.error).toHaveBeenCalledTimes(1);

		await expect(mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:01.000Z', 30_000)).resolves.toBe(
			false
		);

		hoisted.zaddImpl = () => Promise.resolve(1);
		await vi.advanceTimersByTimeAsync(100);

		expect(mod.getScheduleCoordinationStatus()).toBe('ready');
		expect(hoisted.logger.info).toHaveBeenCalledTimes(1);
	});

	it('does not let a probe from a superseded initialization settle a newer one', async () => {
		enableRedis();
		const pendingA = deferred();
		hoisted.zaddImpl = () => pendingA.promise;
		const mod = await import('./schedule-coordination.js');
		const initA = mod.initScheduleCoordination();
		initA.catch(() => undefined);
		client().emit('ready');
		await flush();

		mod.destroyScheduleCoordination();
		await expect(initA).rejects.toThrow(/superseded/i);

		hoisted.zaddImpl = () => Promise.resolve(1);
		const initB = mod.initScheduleCoordination();
		pendingA.resolve(1);
		await flush();
		client().emit('ready');
		await flush();

		await expect(initB).resolves.toBe('ready');
	});

	it('does not let a superseded probe release a newer probe single-flight lock', async () => {
		enableRedis();
		const pendingA = deferred();
		hoisted.zaddImpl = () => pendingA.promise;
		const mod = await import('./schedule-coordination.js');
		const initA = mod.initScheduleCoordination();
		initA.catch(() => undefined);
		client().emit('ready');
		await flush();

		mod.destroyScheduleCoordination();
		await expect(initA).rejects.toThrow(/superseded/i);

		const pendingB = deferred();
		hoisted.zaddImpl = () => pendingB.promise;
		const initB = mod.initScheduleCoordination();
		initB.catch(() => undefined);
		client().emit('ready');
		await flush();

		client().zadd.mockClear();
		pendingA.resolve(1);
		await vi.advanceTimersByTimeAsync(200);

		expect(client().zadd).not.toHaveBeenCalled();

		pendingB.resolve(1);
		await flush();
		await expect(initB).resolves.toBe('ready');
	});
});

describe('createRunCoordinator', () => {
	const key = 'flow-a:2026-08-11T00:00:00.000Z';
	const occurrence = Date.parse('2026-08-11T00:00:00.000Z');

	it('admits the first claim with exact ZADD GT CH arguments', async () => {
		const mod = await initReady();
		client().zadd.mockClear();
		hoisted.zaddImpl = () => Promise.resolve(1);

		await expect(mod.createRunCoordinator('flow-a').shouldRun(key, 30_000)).resolves.toBe(true);

		expect(client().zadd).toHaveBeenCalledWith('cairncms:schedule-coordination', 'GT', 'CH', occurrence, 'flow-a');
	});

	it('rejects an equal or lower occurrence', async () => {
		const mod = await initReady();
		hoisted.zaddImpl = () => Promise.resolve(0);

		await expect(mod.createRunCoordinator('flow-a').shouldRun(key, 30_000)).resolves.toBe(false);
	});

	it('recovers the occurrence timestamp from the key ISO suffix', async () => {
		const mod = await initReady();
		client().zadd.mockClear();

		await mod.createRunCoordinator('flow-a').shouldRun('flow-a:2027-03-04T09:30:00.000Z', 30_000);

		const claimScore = client().zadd.mock.calls[0]![3];
		expect(claimScore).toBe(Date.parse('2027-03-04T09:30:00.000Z'));
	});

	it('classifies a malformed key as a content-free coordination error with no occurrence and no Redis call', async () => {
		const mod = await initReady();
		client().zadd.mockClear();
		const coordinator = mod.createRunCoordinator('flow-a');

		const badKeys = [
			'flow-a',
			'flow-a:2027-13-40T99:99:99.zzzZ',
			'flow-a:2027-02-29T00:00:00.000Z',
			'flow-a:2027-04-31T00:00:00.000Z',
		];

		for (const bad of badKeys) {
			const error = (await coordinator.shouldRun(bad, 30_000).then(
				() => null,
				(reason) => reason
			)) as InstanceType<typeof mod.ScheduleCoordinationError>;

			expect(error).toBeInstanceOf(mod.ScheduleCoordinationError);
			expect(error.message).toBe('Schedule coordination failed');
			expect(error.occurrence).toBeUndefined();
		}

		expect(client().zadd).not.toHaveBeenCalled();
	});

	it('classifies an uninitialized claim as a coordination error carrying the occurrence', async () => {
		enableRedis();
		const mod = await import('./schedule-coordination.js');
		const coordinator = mod.createRunCoordinator('flow-a');

		const error = (await coordinator.shouldRun(key, 30_000).then(
			() => null,
			(reason) => reason
		)) as InstanceType<typeof mod.ScheduleCoordinationError>;

		expect(error).toBeInstanceOf(mod.ScheduleCoordinationError);
		expect(error).toMatchObject({ scheduleId: 'flow-a', occurrence, message: 'Schedule coordination failed' });
	});

	it('recycles a stalled claim, suppresses while unavailable, then recovers on reconnect', async () => {
		const mod = await initReady();
		hoisted.logger.error.mockClear();
		hoisted.logger.info.mockClear();
		client().zadd.mockClear();
		const coordinator = mod.createRunCoordinator('flow-a');

		const queued: Array<(reason: unknown) => void> = [];
		hoisted.zaddImpl = () => new Promise((_resolve, reject) => queued.push(reject));

		hoisted.disconnectImpl = () => {
			while (queued.length) queued.shift()!(new Error('Connection is closed'));
		};

		const first = coordinator.shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000);
		first.catch(() => undefined);

		await vi.advanceTimersByTimeAsync(5_000);

		await expect(first).rejects.toMatchObject({ scheduleId: 'flow-a' });
		expect(client().disconnect).toHaveBeenCalledWith(true);

		client().emit('close');
		await flush();
		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');
		expect(hoisted.logger.error).toHaveBeenCalledTimes(1);

		await expect(coordinator.shouldRun('flow-a:2026-08-11T00:00:01.000Z', 30_000)).resolves.toBe(false);

		hoisted.zaddImpl = () => Promise.resolve(1);
		client().emit('ready');
		await flush();
		expect(mod.getScheduleCoordinationStatus()).toBe('ready');
		expect(hoisted.logger.info).toHaveBeenCalledTimes(1);

		await expect(coordinator.shouldRun('flow-a:2026-08-11T00:00:02.000Z', 30_000)).resolves.toBe(true);
	});

	it('bounds accumulation across a one-second schedule and flushes it in a single recycle', async () => {
		const mod = await initReady();
		client().zadd.mockClear();
		const coordinator = mod.createRunCoordinator('flow-a');

		const queued: Array<(reason: unknown) => void> = [];
		hoisted.zaddImpl = () => new Promise((_resolve, reject) => queued.push(reject));

		hoisted.disconnectImpl = () => {
			while (queued.length) queued.shift()!(new Error('Connection is closed'));
		};

		const claims: Array<Promise<boolean>> = [];

		for (let second = 0; second < 5; second++) {
			const iso = new Date(Date.UTC(2026, 7, 11, 0, 0, second)).toISOString();
			const claim = coordinator.shouldRun(`flow-a:${iso}`, 30_000);
			claim.catch(() => undefined);
			claims.push(claim);

			if (second < 4) await vi.advanceTimersByTimeAsync(1_000);
		}

		expect(queued).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(1_000);

		const settled = await Promise.allSettled(claims);
		expect(settled.every((result) => result.status === 'rejected')).toBe(true);
		expect(queued).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(client().disconnect).toHaveBeenCalledTimes(1);
	});

	it('claims under the operator namespace when set', async () => {
		const mod = await initReady({ MESSENGER_NAMESPACE: 'tenant-7' });
		client().zadd.mockClear();

		await mod.createRunCoordinator('flow-a').shouldRun(key, 30_000);

		expect(client().zadd).toHaveBeenCalledWith('tenant-7:schedule-coordination', 'GT', 'CH', occurrence, 'flow-a');
	});

	it('serves many coordinators from the single shared client', async () => {
		const mod = await initReady();

		await mod.createRunCoordinator('flow-a').shouldRun('flow-a:2026-08-11T00:00:00.000Z', 30_000);
		await mod.createRunCoordinator('flow-b').shouldRun('flow-b:2026-08-11T00:00:00.000Z', 30_000);

		expect(hoisted.constructorArgs).toHaveLength(1);
	});

	it('rethrows a claim error as a content-free ScheduleCoordinationError with the identity and occurrence', async () => {
		const mod = await initReady();
		hoisted.zaddImpl = () => Promise.reject(new Error('AUTH_TOKEN=connection lost'));

		const promise = mod.createRunCoordinator('flow-a').shouldRun(key, 30_000);

		await expect(promise).rejects.toBeInstanceOf(mod.ScheduleCoordinationError);

		await expect(promise).rejects.toMatchObject({
			scheduleId: 'flow-a',
			occurrence,
			message: 'Schedule coordination failed',
		});
	});
});

describe('initialization lifecycle', () => {
	it('builds a single client under concurrent initialization', async () => {
		enableRedis();
		const { initScheduleCoordination } = await import('./schedule-coordination.js');

		const inits = [initScheduleCoordination(), initScheduleCoordination(), initScheduleCoordination()];
		client().emit('ready');
		await flush();
		await Promise.all(inits);

		expect(hoisted.constructorArgs).toHaveLength(1);
	});

	it('is idempotent across sequential calls', async () => {
		const mod = await initReady();

		await mod.initScheduleCoordination();

		expect(hoisted.constructorArgs).toHaveLength(1);
	});

	it('permits initialization again after destroy', async () => {
		enableRedis();
		hoisted.zaddImpl = () => Promise.reject(new Error('ERR syntax error'));
		const mod = await import('./schedule-coordination.js');
		const first = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();
		await expect(first).resolves.toBe('unavailable');

		mod.destroyScheduleCoordination();
		hoisted.zaddImpl = () => Promise.resolve(1);

		const second = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();
		await expect(second).resolves.toBe('ready');
		expect(hoisted.constructorArgs).toHaveLength(2);
	});

	it('rejects an in-flight initialization that a destroy supersedes', async () => {
		enableRedis();
		const { initScheduleCoordination, destroyScheduleCoordination } = await import('./schedule-coordination.js');

		const init = initScheduleCoordination();
		init.catch(() => undefined);

		destroyScheduleCoordination();
		await flush();

		await expect(init).rejects.toThrow(/superseded/i);
	});

	it('disconnects the client on destroy', async () => {
		const mod = await initReady();

		mod.destroyScheduleCoordination();

		expect(client().disconnect).toHaveBeenCalledOnce();
	});

	it('ignores a probe that resolves after destruction', async () => {
		enableRedis();
		const pending = deferred();
		hoisted.zaddImpl = () => pending.promise;
		const mod = await import('./schedule-coordination.js');
		const init = mod.initScheduleCoordination();
		init.catch(() => undefined);
		client().emit('ready');
		await flush();

		mod.destroyScheduleCoordination();
		pending.resolve(1);
		await flush();

		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');
	});
});

describe('getScheduleCoordinationStatus', () => {
	it('reports inactive when coordination is disabled', async () => {
		hoisted.env['MESSENGER_STORE'] = 'local';
		const { getScheduleCoordinationStatus } = await import('./schedule-coordination.js');
		expect(getScheduleCoordinationStatus()).toBe('inactive');
	});

	it('reports the live status across initialization', async () => {
		enableRedis();
		const mod = await import('./schedule-coordination.js');
		expect(mod.getScheduleCoordinationStatus()).toBe('unavailable');

		const init = mod.initScheduleCoordination();
		client().emit('ready');
		await flush();
		await init;

		expect(mod.getScheduleCoordinationStatus()).toBe('ready');
	});
});
