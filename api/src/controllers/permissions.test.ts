import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const { getItemPermissions, captured } = vi.hoisted(() => ({
	getItemPermissions: vi.fn(),
	captured: { cache: undefined as unknown },
}));

vi.mock('../services/permissions.js', () => ({
	PermissionsService: vi.fn().mockImplementation(() => ({ getItemPermissions })),
}));

vi.mock('../services/meta.js', () => ({
	MetaService: vi.fn().mockImplementation(() => ({ getMetaForQuery: vi.fn() })),
}));

vi.mock('../middleware/use-collection.js', () => ({
	default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, res: { json: (body: unknown) => void; locals: Record<string, unknown> }) => {
		captured.cache = res.locals['cache'];
		res.json(res.locals['payload']);
	},
}));

const { default: permissionsController } = await import('./permissions.js');

function makeApp() {
	const app = express();

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = { user: 'u', admin: true };
		req['schema'] = {};
		next();
	});

	app.use('/permissions', permissionsController);

	return app;
}

describe('GET /permissions/me item permissions response cache', () => {
	it('opts the item-permissions response out of the response cache', async () => {
		getItemPermissions.mockResolvedValue({
			update: { access: false, fields: null },
			delete: { access: false },
			share: { access: false },
		});

		captured.cache = undefined;

		const res = await request(makeApp()).get('/permissions/me/articles/5');

		expect(res.status).toBe(200);
		expect(captured.cache).toBe(false);
	});
});
