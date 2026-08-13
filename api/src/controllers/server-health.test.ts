import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const health = vi.fn();

vi.mock('../services/server.js', () => ({
	ServerService: vi.fn().mockImplementation(() => ({ health })),
}));

vi.mock('../services/specifications.js', () => ({
	SpecificationService: vi.fn().mockImplementation(() => ({ oas: { generate: vi.fn() } })),
}));

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, res: { json: (body: unknown) => void; locals: Record<string, unknown> }) =>
		res.json(res.locals['payload']),
}));

const { default: serverController } = await import('./server.js');

function makeApp() {
	const app = express();

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = { admin: true };
		req['schema'] = {};
		next();
	});

	app.use('/server', serverController);

	return app;
}

describe('GET /server/health status mapping', () => {
	it('returns HTTP 200 for a warn (fail-soft) health result', async () => {
		health.mockResolvedValue({ status: 'warn', checks: {} });

		const res = await request(makeApp()).get('/server/health');

		expect(res.status).toBe(200);
	});

	it('returns HTTP 200 for an ok health result', async () => {
		health.mockResolvedValue({ status: 'ok', checks: {} });

		const res = await request(makeApp()).get('/server/health');

		expect(res.status).toBe(200);
	});

	it('returns HTTP 503 for an error health result', async () => {
		health.mockResolvedValue({ status: 'error', checks: {} });

		const res = await request(makeApp()).get('/server/health');

		expect(res.status).toBe(503);
	});
});
