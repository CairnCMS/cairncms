import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from 'express';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CORS_DENY_WITH_VARY, resolveCorsOrigin } from './cors-origin.js';

const ORIGIN = 'http://app.example';
const OTHER = 'http://evil.example';

describe('resolveCorsOrigin', () => {
	it('denies all with no header when CORS_ORIGIN is false', () => {
		expect(resolveCorsOrigin(ORIGIN, false)).toEqual({ allowed: false, middlewareOrigin: false });
	});

	it('reflects any origin when CORS_ORIGIN is true', () => {
		expect(resolveCorsOrigin(ORIGIN, true)).toEqual({ allowed: true, middlewareOrigin: true });
	});

	it('allows any origin with the wildcard', () => {
		expect(resolveCorsOrigin(ORIGIN, '*')).toEqual({ allowed: true, middlewareOrigin: '*' });
	});

	it('matches a fixed string exactly and still advertises it on a mismatch', () => {
		expect(resolveCorsOrigin(ORIGIN, ORIGIN)).toEqual({ allowed: true, middlewareOrigin: ORIGIN });
		expect(resolveCorsOrigin(OTHER, ORIGIN)).toEqual({ allowed: false, middlewareOrigin: ORIGIN });
	});

	it('matches a list by membership and denies-with-vary otherwise', () => {
		expect(resolveCorsOrigin(ORIGIN, [ORIGIN, /nope/])).toEqual({ allowed: true, middlewareOrigin: true });

		expect(resolveCorsOrigin(OTHER, [ORIGIN, /nope/])).toEqual({
			allowed: false,
			middlewareOrigin: CORS_DENY_WITH_VARY,
		});
	});

	it('mirrors the cors boolean behavior for array entries', () => {
		expect(resolveCorsOrigin(ORIGIN, [true])).toEqual({ allowed: true, middlewareOrigin: true });
		expect(resolveCorsOrigin(ORIGIN, [false])).toEqual({ allowed: false, middlewareOrigin: CORS_DENY_WITH_VARY });
	});

	it('matches a regex and denies-with-vary otherwise', () => {
		expect(resolveCorsOrigin(ORIGIN, /app\.example/)).toEqual({ allowed: true, middlewareOrigin: true });

		expect(resolveCorsOrigin(OTHER, /app\.example/)).toEqual({
			allowed: false,
			middlewareOrigin: CORS_DENY_WITH_VARY,
		});
	});

	it('denies an unsupported config shape', () => {
		expect(resolveCorsOrigin(ORIGIN, 42)).toEqual({ allowed: false, middlewareOrigin: false });
	});

	it('matches a global regex once and leaves lastIndex unchanged', () => {
		const pattern = /app\.example/g;
		pattern.lastIndex = 3;

		expect(resolveCorsOrigin(ORIGIN, pattern).allowed).toBe(true);
		expect(resolveCorsOrigin(ORIGIN, pattern).allowed).toBe(true);
		expect(pattern.lastIndex).toBe(3);
	});
});

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cairncms-cors-'));
const EMPTY_CONFIG = join(CONFIG_DIR, 'empty.env');
writeFileSync(EMPTY_CONFIG, '');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	vi.resetModules();
});

afterAll(() => {
	process.env = { ...ORIGINAL_ENV };
	rmSync(CONFIG_DIR, { recursive: true, force: true });
});

async function loadCorsMiddleware(corsOrigin: string): Promise<RequestHandler> {
	vi.resetModules();
	process.env = { ...ORIGINAL_ENV, CONFIG_PATH: EMPTY_CONFIG, CORS_ENABLED: 'true', CORS_ORIGIN: corsOrigin };
	return (await import('../middleware/cors.js')).default;
}

function run(middleware: RequestHandler, method: string, origin: string = ORIGIN): Record<string, string | undefined> {
	const headers: Record<string, string | undefined> = {};

	const req: any = { method, headers: { origin, 'access-control-request-method': 'POST' } };

	const res: any = {
		statusCode: 200,
		setHeader: (key: string, value: unknown) => {
			headers[key.toLowerCase()] = String(value);
		},
		getHeader: (key: string) => headers[key.toLowerCase()],
		end: () => undefined,
	};

	middleware(req, res, () => undefined);
	return headers;
}

describe('cors.ts production middleware', () => {
	it('emits no ACAO when CORS_ORIGIN is false', async () => {
		expect(run(await loadCorsMiddleware('false'), 'GET')['access-control-allow-origin']).toBeUndefined();
	});

	it('reflects with Vary when CORS_ORIGIN is true', async () => {
		const headers = run(await loadCorsMiddleware('true'), 'GET');
		expect(headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(headers['vary']).toBe('Origin');
	});

	it('emits the wildcard for *', async () => {
		expect(run(await loadCorsMiddleware('*'), 'GET')['access-control-allow-origin']).toBe('*');
	});

	it('matches a member of a comma-list and denies-with-vary otherwise', async () => {
		const middleware = await loadCorsMiddleware(`${ORIGIN},http://second.example`);

		expect(run(middleware, 'GET', ORIGIN)['access-control-allow-origin']).toBe(ORIGIN);

		const denied = run(middleware, 'GET', OTHER);
		expect(denied['access-control-allow-origin']).toBeUndefined();
		expect(denied['vary']).toBe('Origin');
	});

	it('advertises a fixed string with Vary even when it does not match', async () => {
		const headers = run(await loadCorsMiddleware(ORIGIN), 'GET', OTHER);
		expect(headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(headers['vary']).toBe('Origin');
	});

	it('matches a regex and denies-with-vary otherwise', async () => {
		const middleware = await loadCorsMiddleware('regex:app\\.example');

		expect(run(middleware, 'GET', ORIGIN)['access-control-allow-origin']).toBe(ORIGIN);

		const denied = run(middleware, 'GET', OTHER);
		expect(denied['access-control-allow-origin']).toBeUndefined();
		expect(denied['vary']).toBe('Origin');
	});

	it('reflects for a boolean-true array entry', async () => {
		const headers = run(await loadCorsMiddleware('json:[true]'), 'GET');
		expect(headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(headers['vary']).toBe('Origin');
	});

	it('carries the other CORS headers on a preflight', async () => {
		const headers = run(await loadCorsMiddleware('true'), 'OPTIONS');
		expect(headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(headers['access-control-allow-methods']).toBeDefined();
	});
});
