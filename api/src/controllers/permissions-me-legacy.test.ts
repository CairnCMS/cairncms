import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/permissions.js', () => ({ PermissionsService: vi.fn() }));
vi.mock('../services/meta.js', () => ({ MetaService: vi.fn() }));

vi.mock('../middleware/use-collection.js', () => ({
	default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../cache.js', () => ({ getCache: () => ({ cache: undefined }), setCacheValue: vi.fn() }));

const { default: permissionsController } = await import('./permissions.js');

function makeApp() {
	const app = express();

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = { user: 'u', admin: true };
		req['schema'] = {};
		req['sanitizedQuery'] = {};
		next();
	});

	app.use('/permissions', permissionsController);

	return app;
}

describe('GET /permissions/me deprecated route', () => {
	it('returns an empty 204 through the real respond middleware', async () => {
		const res = await request(makeApp()).get('/permissions/me');

		expect(res.status).toBe(204);
		expect(res.text).toBe('');
	});
});
