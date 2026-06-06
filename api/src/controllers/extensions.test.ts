import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../extensions.js', () => ({
	getExtensionManager: () => ({
		getDiagnostics: () => [{ name: 'demo', type: 'hook', local: true, status: 'loaded' }],
		getAppExtensions: () => 'export default [];\n',
		getAppExtensionChunk: (name: string) => {
			if (name === 'registered-chunk.js') return 'export const chunk = 1;\n';
			if (name.endsWith('.map')) return '{"version":3,"sources":["secret.js"]}\n';
			return null;
		},
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

describe('GET /extensions/sources serves only registered chunks, never maps', () => {
	it('serves the app entrypoint as javascript', async () => {
		const res = await request(makeApp(null)).get('/extensions/sources/index.js');

		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('application/javascript');
	});

	it('serves a registered chunk', async () => {
		const res = await request(makeApp(null)).get('/extensions/sources/registered-chunk.js');

		expect(res.status).toBe(200);
	});

	it('returns 404 for a .map request even when the manager would return content (fails closed at the boundary)', async () => {
		const res = await request(makeApp(null)).get('/extensions/sources/registered-chunk.js.map');

		expect(res.status).toBe(404);
	});

	it('returns 404 for an unknown chunk', async () => {
		const res = await request(makeApp(null)).get('/extensions/sources/unknown-chunk.js');

		expect(res.status).toBe(404);
	});
});
