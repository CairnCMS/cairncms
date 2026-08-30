import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
	env: {} as Record<string, unknown>,
	messengerStatus: 'available' as string,
	coordinationEnabled: true,
	coordinationStatus: 'ready' as string,
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => hoisted.env[prop as string] }),
	getEnv: () => hoisted.env,
}));

vi.mock('../logger.js', () => ({ default: hoisted.logger }));

const databaseStub = { client: { pool: { numFree: () => 1, numUsed: () => 0 } } };

vi.mock('../database/index.js', () => ({
	default: vi.fn(() => databaseStub),
	getDatabase: vi.fn(() => databaseStub),
	hasDatabaseConnection: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../mailer.js', () => ({ default: vi.fn(() => ({ verify: vi.fn(() => Promise.resolve()) })) }));

vi.mock('../cache.js', () => ({ getCache: vi.fn(() => ({ cache: null })) }));

vi.mock('../storage/index.js', () => ({
	getStorage: vi.fn(() =>
		Promise.resolve({
			location: () => ({
				write: () => Promise.resolve(),
				read: () => Promise.resolve({ on: () => undefined, destroy: () => undefined }),
				delete: () => Promise.resolve(),
			}),
		})
	),
}));

vi.mock('../middleware/rate-limiter-global.js', () => ({ rateLimiterGlobal: {} }));
vi.mock('../middleware/rate-limiter-ip.js', () => ({ rateLimiter: {} }));

vi.mock('../server.js', () => ({ SERVER_ONLINE: true }));
vi.mock('../utils/package.js', () => ({ version: '0.0.0-test' }));
vi.mock('nanoid', () => ({ nanoid: () => 'abcde' }));

vi.mock('../messenger.js', () => ({ getMessengerStatus: () => hoisted.messengerStatus }));

vi.mock('../schedule-coordination.js', () => ({
	isCoordinationEnabled: () => hoisted.coordinationEnabled,
	getScheduleCoordinationStatus: () => hoisted.coordinationStatus,
}));

vi.mock('./settings.js', () => ({
	SettingsService: vi.fn().mockImplementation(() => ({ readSingleton: vi.fn() })),
}));

import { ServerService } from './server.js';

const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

function healthFor(accountability: Accountability | null) {
	const service = new ServerService({ knex: {} as Knex, schema, accountability });
	return service.health();
}

beforeEach(() => {
	for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
	hoisted.env['KEY'] = 'test-key';
	hoisted.env['DB_CLIENT'] = 'postgres';
	hoisted.env['CACHE_ENABLED'] = false;
	hoisted.env['RATE_LIMITER_ENABLED'] = false;
	hoisted.env['RATE_LIMITER_GLOBAL_ENABLED'] = false;
	hoisted.env['STORAGE_LOCATIONS'] = 'local';
	hoisted.env['MESSENGER_STORE'] = 'redis';
	hoisted.messengerStatus = 'available';
	hoisted.coordinationEnabled = true;
	hoisted.coordinationStatus = 'ready';
	hoisted.logger.warn.mockClear();
});

const admin = { admin: true } as Accountability;

describe('ServerService.health messenger check', () => {
	it('reports a warn messenger check and a warn rollup when the messenger is unavailable', async () => {
		hoisted.messengerStatus = 'unavailable';

		const data = await healthFor(admin);

		expect(data['checks']['messenger:status'][0]).toMatchObject({ status: 'warn', componentType: 'messenger' });
		expect(data['status']).toBe('warn');
	});

	it('reports an ok messenger check when the messenger is available', async () => {
		const data = await healthFor(admin);

		expect(data['checks']['messenger:status'][0]).toMatchObject({ status: 'ok', componentType: 'messenger' });
		expect(data['status']).toBe('ok');
	});

	it('emits no messenger check when the messenger store is not redis', async () => {
		hoisted.env['MESSENGER_STORE'] = 'local';
		hoisted.coordinationEnabled = false;

		const data = await healthFor(admin);

		expect(data['checks']).not.toHaveProperty('messenger:status');
	});

	it('promotes the rollup to warn without emitting the threshold-worded log line', async () => {
		hoisted.messengerStatus = 'unavailable';

		const data = await healthFor(admin);

		expect(data['status']).toBe('warn');
		expect(hoisted.logger.warn).not.toHaveBeenCalled();
	});

	it('still logs the threshold-worded warning for a real threshold breach', async () => {
		hoisted.env['DB_HEALTHCHECK_THRESHOLD'] = '-1';

		const data = await healthFor(admin);

		expect(data['status']).toBe('warn');
		expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
		expect(hoisted.logger.warn.mock.calls[0]![0]).toMatch(/in WARN state, the observed value/);
	});
});

describe('ServerService.health schedule-coordination check', () => {
	it('reports a warn coordination check and a warn rollup when coordination is unavailable', async () => {
		hoisted.coordinationStatus = 'unavailable';

		const data = await healthFor(admin);

		expect(data['checks']['scheduleCoordination:status'][0]).toMatchObject({
			status: 'warn',
			componentType: 'coordination',
		});

		expect(data['status']).toBe('warn');
	});

	it('reports an ok coordination check when coordination is ready', async () => {
		const data = await healthFor(admin);

		expect(data['checks']['scheduleCoordination:status'][0]).toMatchObject({
			status: 'ok',
			componentType: 'coordination',
		});

		expect(data['status']).toBe('ok');
	});

	it('emits no coordination check when coordination is inactive', async () => {
		hoisted.coordinationEnabled = false;

		const data = await healthFor(admin);

		expect(data['checks']).not.toHaveProperty('scheduleCoordination:status');
	});
});

describe('ServerService.health visibility', () => {
	it('returns only the status to a non-admin', async () => {
		hoisted.messengerStatus = 'unavailable';

		const data = await healthFor({ admin: false } as Accountability);

		expect(data).toEqual({ status: 'warn' });
	});

	it('returns the full check detail to an admin', async () => {
		const data = await healthFor(admin);

		expect(data['checks']).toHaveProperty('messenger:status');
		expect(data['checks']).toHaveProperty('scheduleCoordination:status');
	});
});
