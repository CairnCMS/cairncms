import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REALTIME_SHUTDOWN_FAILED = 'WebSocket realtime shutdown did not complete in the grace period, forcing exit';

const createTerminus = vi.fn();
const activateRealtime = vi.fn();
const databaseDestroy = vi.fn(async () => undefined);
const getDatabase = vi.fn(() => ({ destroy: databaseDestroy }));

vi.mock('@godaddy/terminus', () => ({ createTerminus }));
vi.mock('./app.js', () => ({ default: vi.fn(async () => (_req: unknown, res: { end: () => void }) => res.end()) }));
vi.mock('./database/index.js', () => ({ default: getDatabase }));
vi.mock('./messenger.js', () => ({ getMessenger: vi.fn(() => ({})) }));
vi.mock('./utils/get-schema.js', () => ({ getSchema: vi.fn() }));
vi.mock('./utils/get-config-from-env.js', () => ({ getConfigFromEnv: vi.fn(() => ({})) }));
vi.mock('./websocket/controllers/index.js', () => ({ activateRealtime }));
vi.mock('./emitter.js', () => ({ default: { emitAction: vi.fn() } }));
vi.mock('./logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('./env.js', () => ({ default: { SERVER_SHUTDOWN_TIMEOUT: 1000, NODE_ENV: 'test' } }));

const { createServer } = await import('./server.js');
const logger = (await import('./logger.js')).default;

function onSignalHook(): () => Promise<void> {
	const options = createTerminus.mock.calls[createTerminus.mock.calls.length - 1]![1];
	return options.onSignal;
}

beforeEach(() => {
	createTerminus.mockReset();
	activateRealtime.mockReset();
	databaseDestroy.mockReset().mockResolvedValue(undefined);
	getDatabase.mockClear();
	vi.mocked(logger.error).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createServer realtime wiring', () => {
	it('activates realtime and attaches one upgrade listener when active', async () => {
		activateRealtime.mockResolvedValue({ handleUpgrade: vi.fn(), stop: vi.fn(async () => undefined) });

		const server = await createServer();

		expect(activateRealtime).toHaveBeenCalledWith(
			expect.objectContaining({ app: expect.anything(), database: expect.anything(), messenger: expect.anything() })
		);

		expect(server.listenerCount('upgrade')).toBe(1);
	});

	it('attaches no upgrade listener and still serves when realtime is inactive', async () => {
		activateRealtime.mockResolvedValue(null);

		const server = await createServer();

		expect(server.listenerCount('upgrade')).toBe(0);

		await onSignalHook()();
		expect(databaseDestroy).toHaveBeenCalledTimes(1);
	});

	it('detaches the upgrade listener and stops realtime before destroying the database', async () => {
		const order: string[] = [];
		const handleUpgrade = vi.fn();

		activateRealtime.mockResolvedValue({
			handleUpgrade,
			stop: vi.fn(async () => {
				order.push('realtime.stop');
			}),
		});

		databaseDestroy.mockImplementation(async () => {
			order.push('database.destroy');
		});

		const server = await createServer();
		expect(server.listenerCount('upgrade')).toBe(1);

		await onSignalHook()();

		expect(order).toEqual(['realtime.stop', 'database.destroy']);
		expect(server.listenerCount('upgrade')).toBe(0);
	});

	it('logs the fixed diagnostic and skips database.destroy when realtime.stop times out', async () => {
		vi.useFakeTimers();

		activateRealtime.mockResolvedValue({
			handleUpgrade: vi.fn(),
			stop: vi.fn(() => new Promise<void>(() => undefined)),
		});

		await createServer();

		const settled = onSignalHook()().then(
			() => 'resolved',
			() => 'rejected'
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(await settled).toBe('rejected');
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith(REALTIME_SHUTDOWN_FAILED);
		expect(databaseDestroy).not.toHaveBeenCalled();
	});

	it('logs the fixed diagnostic and skips database.destroy when realtime.stop rejects immediately', async () => {
		activateRealtime.mockResolvedValue({
			handleUpgrade: vi.fn(),
			stop: vi.fn(async () => {
				throw new Error('teardown boom');
			}),
		});

		await createServer();

		await expect(onSignalHook()()).rejects.toThrow();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith(REALTIME_SHUTDOWN_FAILED);
		expect(databaseDestroy).not.toHaveBeenCalled();
	});
});
