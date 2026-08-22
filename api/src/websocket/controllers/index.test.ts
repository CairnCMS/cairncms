import { beforeEach, describe, expect, it, vi } from 'vitest';

const producerRegister = vi.fn();
const producerDestroy = vi.fn();
const coordinatorStart = vi.fn();
const coordinatorStop = vi.fn(async () => undefined);
const controllerTerminate = vi.fn(async () => undefined);
const controllerHandleUpgrade = vi.fn();
const controllerCloseConnection = vi.fn();
const controllerBroadcast = vi.fn();
const controllerClientSnapshot = vi.fn(() => new Set());

const admissionLimits: unknown[] = [];
const coordinatorOptions: any[] = [];
const controllerOptions: any[] = [];

class MockAdmission {
	constructor(limits: unknown) {
		admissionLimits.push(limits);
	}
}

class MockRegistry {}

class MockProducer {
	register = producerRegister;
	destroy = producerDestroy;
	constructor(public messenger: unknown) {}
}

class MockCoordinator {
	start = coordinatorStart;
	stop = coordinatorStop;
	constructor(options: unknown) {
		coordinatorOptions.push(options);
	}
}

class MockController {
	handleUpgrade = controllerHandleUpgrade;
	closeConnection = controllerCloseConnection;
	broadcast = controllerBroadcast;
	clientSnapshot = controllerClientSnapshot;
	terminate = controllerTerminate;
	constructor(options: unknown) {
		controllerOptions.push(options);
	}
}

const createUpgradeOriginPredicate = vi.fn(() => () => true);
const getWebSocketConfig = vi.fn();

vi.mock('../admission.js', () => ({ Admission: MockAdmission }));
vi.mock('../subscriptions.js', () => ({ SubscriptionRegistry: MockRegistry }));
vi.mock('./hooks.js', () => ({ HookEventProducer: MockProducer }));
vi.mock('../dispatch.js', () => ({ DispatchCoordinator: MockCoordinator, resolveDeliveryConcurrency: vi.fn(() => 7) }));
vi.mock('./rest.js', () => ({ WebSocketController: MockController }));
vi.mock('../origin.js', () => ({ createUpgradeOriginPredicate }));
vi.mock('../config.js', () => ({ getWebSocketConfig }));
vi.mock('../../middleware/rate-limiter-ip.js', () => ({ consumeIpRateLimit: vi.fn() }));
vi.mock('../../middleware/rate-limiter-global.js', () => ({ consumeGlobalRateLimit: vi.fn() }));
vi.mock('../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

const { activateRealtime } = await import('./index.js');
const { getActiveRealtime } = await import('./active.js');
const { WebSocketService } = await import('../../services/websocket.js');
const { ServiceUnavailableException } = await import('../../exceptions/index.js');
const logger = (await import('../../logger.js')).default;

const SHARED = {
	maxPayload: 1_048_576,
	heartbeatPeriodMs: 30_000,
	userConnLimit: 10,
	ipConnLimit: 50,
	processConnLimit: 1000,
};

const REST_CONFIG = { path: '/websocket', connLimit: 1000, auth: 'public', authTimeoutMs: 10_000 };

function activeConfig(rest: unknown = { active: true, config: REST_CONFIG }) {
	return { active: true, shared: SHARED, rest };
}

const DEPS = {
	app: {} as never,
	database: {} as never,
	messenger: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn(), getStatus: vi.fn() } as never,
	getSchema: async () => ({} as never),
};

beforeEach(() => {
	for (const spy of [
		producerRegister,
		producerDestroy,
		coordinatorStart,
		coordinatorStop,
		controllerTerminate,
		controllerHandleUpgrade,
		controllerCloseConnection,
		controllerBroadcast,
		controllerClientSnapshot,
		createUpgradeOriginPredicate,
		getWebSocketConfig,
	]) {
		spy.mockReset();
	}

	admissionLimits.length = 0;
	coordinatorOptions.length = 0;
	controllerOptions.length = 0;

	coordinatorStop.mockResolvedValue(undefined);
	controllerTerminate.mockResolvedValue(undefined);
	controllerClientSnapshot.mockReturnValue(new Set());
	createUpgradeOriginPredicate.mockReturnValue(() => true);
	vi.mocked(logger.error).mockClear();
});

describe('activateRealtime', () => {
	it('builds and starts the stack for an active config and returns a handle', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		const activation = await activateRealtime(DEPS);

		expect(activation).not.toBeNull();
		expect(producerRegister).toHaveBeenCalledTimes(1);
		expect(coordinatorStart).toHaveBeenCalledTimes(1);
		expect(controllerOptions).toHaveLength(1);
		expect(controllerOptions[0]).toMatchObject({ transport: 'rest', path: '/websocket', authMode: 'public' });
		expect(admissionLimits[0]).toEqual({ process: 1000, ip: 50, user: 10, transports: { rest: 1000 } });
		expect(coordinatorOptions[0].deliveryConcurrency).toBe(7);
	});

	it('fans the upgrade and the close to every controller', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());
		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		const req = {} as never;
		const socket = {} as never;
		const head = Buffer.alloc(0);
		activation.handleUpgrade(req, socket, head);
		expect(controllerHandleUpgrade).toHaveBeenCalledWith(req, socket, head);

		coordinatorOptions[0].closeConnection({ uid: 'x' } as never, 1013);
		expect(controllerCloseConnection).toHaveBeenCalledWith({ uid: 'x' }, 1013);
	});

	it('stop tears down producer, coordinator, and controllers, and shares one promise', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());
		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		const first = activation.stop();
		const second = activation.stop();
		expect(first).toBe(second);

		await first;
		expect(producerDestroy).toHaveBeenCalledTimes(1);
		expect(coordinatorStop).toHaveBeenCalledTimes(1);
		expect(controllerTerminate).toHaveBeenCalledTimes(1);
	});

	it('terminates every controller even while coordinator shutdown stalls', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());
		let releaseCoordinator!: () => void;
		coordinatorStop.mockReturnValue(new Promise<void>((resolve) => (releaseCoordinator = () => resolve())));

		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		void activation.stop();
		await new Promise((resolve) => setImmediate(resolve));

		expect(controllerTerminate).toHaveBeenCalledTimes(1);
		releaseCoordinator();
	});

	it('returns null and logs nothing for a disabled realtime', async () => {
		getWebSocketConfig.mockReturnValue({ active: false, errors: [] });

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).not.toHaveBeenCalled();
		expect(producerRegister).not.toHaveBeenCalled();
	});

	it('returns null and logs the variable-named error once for an invalid master setting', async () => {
		getWebSocketConfig.mockReturnValue({
			active: false,
			errors: [{ envVar: 'WEBSOCKETS_ENABLED', message: 'WEBSOCKETS_ENABLED must be true or false' }],
		});

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith('WEBSOCKETS_ENABLED must be true or false');
	});

	it('returns null with no transport when REST is disabled, and logs a REST error when invalid', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig({ active: false, errors: [] }));
		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).not.toHaveBeenCalled();

		getWebSocketConfig.mockReturnValue(
			activeConfig({
				active: false,
				errors: [{ envVar: 'WEBSOCKETS_REST_PATH', message: 'WEBSOCKETS_REST_PATH must be a URL path' }],
			})
		);

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).toHaveBeenCalledWith('WEBSOCKETS_REST_PATH must be a URL path');
	});

	it('fails closed when the origin predicate throws, before anything is built', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		createUpgradeOriginPredicate.mockImplementation(() => {
			throw new Error('bad PUBLIC_URL');
		});

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(producerRegister).not.toHaveBeenCalled();
		expect(coordinatorStart).not.toHaveBeenCalled();
	});

	it('rolls back a throw inside producer.register(), cleaning the controllers', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		producerRegister.mockImplementation(() => {
			throw new Error('register boom');
		});

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(producerDestroy).toHaveBeenCalledTimes(1);
		expect(controllerTerminate).toHaveBeenCalledTimes(1);
		expect(coordinatorStart).not.toHaveBeenCalled();
	});

	it('rolls back a throw inside coordinator.start(), cleaning producer and controllers', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		coordinatorStart.mockImplementation(() => {
			throw new Error('start boom');
		});

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(producerDestroy).toHaveBeenCalledTimes(1);
		expect(coordinatorStop).toHaveBeenCalledTimes(1);
		expect(controllerTerminate).toHaveBeenCalledTimes(1);
	});

	it('rollback survives a rejecting cleanup and still returns null', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		coordinatorStart.mockImplementation(() => {
			throw new Error('start boom');
		});

		coordinatorStop.mockRejectedValue(new Error('unsubscribe boom'));

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(producerDestroy).toHaveBeenCalledTimes(1);
		expect(controllerTerminate).toHaveBeenCalledTimes(1);
	});
});

describe('getActiveRealtime', () => {
	it('is set on activation, transport-keyed, and cleared on stop', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		const access = getActiveRealtime();
		expect(access).not.toBeNull();
		expect(access!.transport('rest')).not.toBeNull();
		expect(access!.transport('graphql')).toBeNull();

		access!.transport('rest')!.broadcast('hi', { user: 'x' });
		expect(controllerBroadcast).toHaveBeenCalledWith('hi', { user: 'x' });

		expect(access!.transport('rest')!.clients()).toBeInstanceOf(Set);
		expect(controllerClientSnapshot).toHaveBeenCalledTimes(1);

		await activation.stop();
		expect(getActiveRealtime()).toBeNull();
	});

	it('reports the activated settings from info()', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		expect(getActiveRealtime()!.info()).toEqual({
			rest: { authentication: 'public', path: '/websocket' },
			heartbeat: 30,
		});

		await activation.stop();
	});

	it('stays null after an activation that fails to construct', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		const ok = await activateRealtime(DEPS);
		await ok!.stop();
		expect(getActiveRealtime()).toBeNull();

		coordinatorStart.mockImplementation(() => {
			throw new Error('start boom');
		});

		expect(await activateRealtime(DEPS)).toBeNull();
		expect(getActiveRealtime()).toBeNull();
	});

	it('stopping the first of two activations does not clear the second', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		const first = await activateRealtime(DEPS);
		const firstAccess = getActiveRealtime();
		const second = await activateRealtime(DEPS);
		const secondAccess = getActiveRealtime();

		expect(secondAccess).not.toBeNull();
		expect(secondAccess).not.toBe(firstAccess);

		await first!.stop();
		expect(getActiveRealtime()).toBe(secondAccess);

		await second!.stop();
		expect(getActiveRealtime()).toBeNull();
	});

	it('clears synchronously on stop so an existing service cannot reach controllers', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		let release!: () => void;
		coordinatorStop.mockReturnValue(new Promise<void>((resolve) => (release = () => resolve())));

		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		const service = new WebSocketService();

		void activation.stop();

		expect(getActiveRealtime()).toBeNull();
		expect(() => service.broadcast('x')).toThrow(ServiceUnavailableException);
		expect(() => service.clients()).toThrow(ServiceUnavailableException);

		release();
	});

	it('is usable when constructed before activation, once activation completes', async () => {
		getWebSocketConfig.mockReturnValue(activeConfig());

		const service = new WebSocketService();

		const activation = await activateRealtime(DEPS);
		if (activation === null) throw new Error('expected activation');

		service.broadcast('later', { user: 'u' });
		expect(controllerBroadcast).toHaveBeenCalledWith('later', { user: 'u' });

		await activation.stop();
	});
});
