import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioredisState = vi.hoisted(() => ({
	constructorArgs: [] as unknown[][],
	instances: [] as Array<{ emit: (event: string, ...args: unknown[]) => void }>,
}));

vi.mock('ioredis', () => ({
	Redis: class {
		listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
		zadd = vi.fn(() => Promise.resolve(1));
		disconnect = vi.fn(() => undefined);

		on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			(this.listeners[event] ??= []).push(callback);
			return this;
		});

		emit(event: string, ...args: unknown[]) {
			for (const callback of this.listeners[event] ?? []) callback(...args);
		}

		constructor(...args: unknown[]) {
			ioredisState.constructorArgs.push(args);
			ioredisState.instances.push(this as never);
		}
	},
}));

const SECRET = 'redis-secret-from-file-9f3';

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'cairncms-redis-'));
	savedEnv = { ...process.env };

	for (const key of Object.keys(process.env)) {
		if (key.startsWith('MESSENGER_')) delete process.env[key];
	}

	process.env['CONFIG_PATH'] = path.join(dir, 'no-such-config');

	ioredisState.constructorArgs.length = 0;
	ioredisState.instances.length = 0;
	vi.resetModules();
});

afterEach(() => {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnv);

	rmSync(dir, { recursive: true, force: true });
	vi.resetModules();
});

describe('coordinator Redis configuration', () => {
	it('resolves MESSENGER_REDIS_PASSWORD_FILE through the real env loader into the client config', async () => {
		const secretPath = path.join(dir, 'redis-password');
		writeFileSync(secretPath, SECRET);

		process.env['MESSENGER_STORE'] = 'redis';
		process.env['MESSENGER_REDIS_HOST'] = '127.0.0.1';
		process.env['MESSENGER_REDIS_PORT'] = '6379';
		process.env['MESSENGER_REDIS_PASSWORD_FILE'] = secretPath;

		const { initScheduleCoordination } = await import('./schedule-coordination.js');
		const init = initScheduleCoordination();
		ioredisState.instances[0]!.emit('ready');
		await init;

		expect(ioredisState.constructorArgs).toHaveLength(1);
		const [config] = ioredisState.constructorArgs[0] as [Record<string, unknown>];

		expect(config).toMatchObject({ host: '127.0.0.1', port: 6379, password: SECRET });
	});
});
