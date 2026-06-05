import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../extensions.js', () => ({
	getExtensionManager: () => ({
		getDiagnostics: () => [{ name: 'demo', type: 'hook', local: true, status: 'loaded' }],
	}),
}));

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, res: { json: (body: unknown) => void; locals: Record<string, unknown> }) =>
		res.json(res.locals['payload']),
}));

const { default: extensionsController } = await import('./extensions.js');

function makeApp(accountability: { admin: boolean } | null) {
	const app = express();

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = accountability;
		next();
	});

	app.use('/extensions', extensionsController);

	app.use((err: { status?: number; message?: string }, _req: unknown, res: any, _next: unknown) => {
		res.status(err?.status ?? 500).json({ error: err?.message });
	});

	return app;
}

describe('GET /extensions admin guard', () => {
	it('returns 403 for a non-admin', async () => {
		const res = await request(makeApp({ admin: false })).get('/extensions');
		expect(res.status).toBe(403);
	});

	it('returns 403 for an unauthenticated request', async () => {
		const res = await request(makeApp(null)).get('/extensions');
		expect(res.status).toBe(403);
	});

	it('returns the diagnostic inventory for an admin', async () => {
		const res = await request(makeApp({ admin: true })).get('/extensions');

		expect(res.status).toBe(200);
		expect(res.body.data?.[0]?.name).toBe('demo');
	});
});
