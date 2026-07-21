import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { readSingleton } = vi.hoisted(() => ({ readSingleton: vi.fn() }));

vi.mock('./settings.js', () => ({
	SettingsService: vi.fn().mockImplementation(() => ({ readSingleton })),
}));

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
