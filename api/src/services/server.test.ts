import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { readSingleton, getActiveRealtime } = vi.hoisted(() => ({
	readSingleton: vi.fn(),
	getActiveRealtime: vi.fn(),
}));

vi.mock('./settings.js', () => ({
	SettingsService: vi.fn().mockImplementation(() => ({ readSingleton })),
}));

vi.mock('../websocket/controllers/active.js', () => ({ getActiveRealtime }));

import { ServerService } from './server.js';

const projectStub = {
	project_name: 'Test',
	project_descriptor: null,
	project_logo: null,
	project_color: null,
	default_language: 'en-US',
	public_foreground: null,
	public_background: null,
	public_note: null,
	custom_css: null,
};

const schema = { collections: {}, relations: [] } satisfies SchemaOverview;

const authenticatedUser = {
	role: 'role-id',
	user: 'user-id',
	admin: false,
	app: true,
} satisfies Accountability;

function serverInfoFor(accountability: Accountability | null) {
	const service = new ServerService({ knex: {} as Knex, schema, accountability });
	return service.serverInfo();
}

describe('ServerService.serverInfo queryLimit exposure', () => {
	beforeEach(() => {
		readSingleton.mockResolvedValue(projectStub);
	});

	test('exposes queryLimit to a share without the user-only rate limits', async () => {
		const share = {
			role: 'role-id',
			share: 'share-id',
			user: null,
			admin: false,
			app: false,
		} satisfies Accountability;

		const info = await serverInfoFor(share);

		expect(info['queryLimit']).toEqual({ default: 100, max: -1 });
		expect(info).not.toHaveProperty('rateLimit');
		expect(info).not.toHaveProperty('rateLimitGlobal');
	});

	test('exposes queryLimit and both rate limits to an authenticated user', async () => {
		const user = {
			role: 'role-id',
			user: 'user-id',
			admin: false,
			app: true,
		} satisfies Accountability;

		const info = await serverInfoFor(user);

		expect(info['queryLimit']).toEqual({ default: 100, max: -1 });
		expect(info).toHaveProperty('rateLimit');
		expect(info).toHaveProperty('rateLimitGlobal');
	});

	test('omits queryLimit and rate limits for an unauthenticated request', async () => {
		const info = await serverInfoFor(null);

		expect(info).not.toHaveProperty('queryLimit');
		expect(info).not.toHaveProperty('rateLimit');
		expect(info).not.toHaveProperty('rateLimitGlobal');
	});
});

describe('ServerService.serverInfo websocket exposure', () => {
	beforeEach(() => {
		readSingleton.mockResolvedValue(projectStub);
		getActiveRealtime.mockReset();
	});

	test('reports the running realtime settings to an authenticated user', async () => {
		getActiveRealtime.mockReturnValue({
			transport: () => null,
			info: () => ({ rest: { authentication: 'strict', path: '/ws' }, heartbeat: 30 }),
		});

		const info = await serverInfoFor(authenticatedUser);

		expect(info['websocket']).toEqual({ rest: { authentication: 'strict', path: '/ws' }, heartbeat: 30 });
	});

	test('reports websocket false when realtime is not active', async () => {
		getActiveRealtime.mockReturnValue(null);

		const info = await serverInfoFor(authenticatedUser);

		expect(info['websocket']).toBe(false);
	});

	test('reports rest false when the REST transport is inactive', async () => {
		getActiveRealtime.mockReturnValue({
			transport: () => null,
			info: () => ({ rest: false, heartbeat: 30 }),
		});

		const info = await serverInfoFor(authenticatedUser);

		expect(info['websocket']).toEqual({ rest: false, heartbeat: 30 });
	});

	test('omits websocket for an unauthenticated request', async () => {
		getActiveRealtime.mockReturnValue({
			transport: () => null,
			info: () => ({ rest: false, heartbeat: 30 }),
		});

		const info = await serverInfoFor(null);

		expect(info).not.toHaveProperty('websocket');
	});
});
