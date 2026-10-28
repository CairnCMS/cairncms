import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REALTIME_SHUTDOWN_FAILED = 'WebSocket realtime shutdown did not complete in the grace period, forcing exit';

const createTerminus = vi.fn();
const activateRealtime = vi.fn();
const databaseDestroy = vi.fn<import('knex').Knex['destroy']>(async () => undefined);
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

vi.mock('./env.js', () => ({
	default: {
		SERVER_SHUTDOWN_TIMEOUT: 1000,
		NODE_ENV: 'test',
		QUERYSTRING_PARSE_DEPTH: 5,
		QUERYSTRING_ARRAY_LIMIT: 100,
	},
}));

const { createServer } = await import('./server.js');
const logger = (await import('./logger.js')).default;
const emitter = (await import('./emitter.js')).default;

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

describe('response diagnostics', () => {
	async function fireResponse(originalUrl: string) {
		activateRealtime.mockResolvedValue(null);
		vi.mocked(emitter.emitAction).mockClear();

		const server = await createServer();
		const onRequest = server.listeners('request').at(-1) as (req: unknown, res: unknown) => void;

		const req = {
			socket: { bytesRead: 10, bytesWritten: 20 },
			headers: { host: 'localhost' },
			method: 'GET',
			originalUrl,
			url: originalUrl,
			aborted: false,
			complete: true,
			accountability: null,
		};

		const res = Object.assign(new EventEmitter(), { statusCode: 404, getHeaders: () => ({}) });

		onRequest(req, res);
		res.emit('finish');

		const call = vi.mocked(emitter.emitAction).mock.calls.at(-1);
		expect(call?.[0]).toBe('response');
		return call?.[1]!['request'] as { url: unknown; path: unknown; query: unknown };
	}

	it('emits the response hook with a raw url, null path, and empty query for an unparseable target', async () => {
		const request = await fireResponse('http://[/items/books');

		expect(request.url).toBe('http://[/items/books');
		expect(request.path).toBeNull();
		expect(request.query).toEqual({});
	});

	it('emits the parsed url, path, and query for an ordinary target', async () => {
		const request = await fireResponse('/items/books?limit=1');

		expect(request.url).toBe('/items/books?limit=1');
		expect(request.path).toBe('/items/books');
		expect(request.query).toEqual({ limit: '1' });
	});
});
