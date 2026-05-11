import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, test } from 'vitest';

function buildHarness(applyCoop: boolean) {
	const app = express();

	const authRouter = express.Router();
	authRouter.get('/test', (_req, res) => res.json({ ok: true }));

	if (applyCoop) {
		app.use('/auth', helmet.crossOriginOpenerPolicy(), authRouter);
	} else {
		app.use('/auth', authRouter);
	}

	app.get('/server/info', (_req, res) => res.json({ ok: true }));

	return app;
}

describe('Cross-Origin-Opener-Policy on /auth routes', () => {
	test('GET /auth/* response includes Cross-Origin-Opener-Policy: same-origin when the middleware is mounted', async () => {
		const app = buildHarness(true);
		const res = await request(app).get('/auth/test');
		expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
	});

	test('GET /server/info does not get the COOP header (regression guard: not set globally)', async () => {
		const app = buildHarness(true);
		const res = await request(app).get('/server/info');
		expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
	});

	test('without the middleware mounted, GET /auth/* does not get the COOP header (baseline negative)', async () => {
		const app = buildHarness(false);
		const res = await request(app).get('/auth/test');
		expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
	});
});
