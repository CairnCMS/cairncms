import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
	env: {} as Record<string, unknown>,
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => hoisted.env[prop as string] }),
	getEnv: () => hoisted.env,
}));

vi.mock('./logger.js', () => ({ default: hoisted.logger }));

beforeEach(() => {
	for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
	hoisted.logger.warn.mockClear();
	vi.resetModules();
});

afterEach(async () => {
	const { destroyMessenger } = await import('./messenger.js');
	destroyMessenger();
});

describe('messenger construction against real ioredis', () => {
	it('fails soft on a malformed MESSENGER_REDIS url instead of escaping construction', async () => {
		hoisted.env['MESSENGER_STORE'] = 'redis';
		hoisted.env['MESSENGER_REDIS'] = 'redis://%zz@localhost:6379';

		const { getMessenger } = await import('./messenger.js');

		let status: string | undefined;

		expect(() => {
			status = getMessenger().getStatus();
		}).not.toThrow();

		const { MESSENGER_CONFIG_INVALID } = await import('./messenger.js');
		expect(status).toBe('unavailable');
		expect(hoisted.logger.warn).toHaveBeenCalledWith(MESSENGER_CONFIG_INVALID);
	});
});
