import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from 'express';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cairncms-limiter-'));
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

async function loadIp(env: Record<string, string>) {
	vi.resetModules();
	process.env = { ...ORIGINAL_ENV, CONFIG_PATH: EMPTY_CONFIG, ...env };
	return import('./rate-limiter-ip.js');
}

async function loadGlobal(env: Record<string, string>) {
	vi.resetModules();
	process.env = { ...ORIGINAL_ENV, CONFIG_PATH: EMPTY_CONFIG, ...env };
	return import('./rate-limiter-global.js');
}

async function consumeViaHttp(middleware: RequestHandler, ip: string): Promise<void> {
	const req: any = {
		app: { get: (key: string) => (key === 'trust proxy fn' ? () => false : undefined) },
		socket: { remoteAddress: ip },
		headers: {},
	};

	const res: any = { set: () => undefined };
	await middleware(req, res, () => undefined);
}

const IP_ENABLED = {
	RATE_LIMITER_ENABLED: 'true',
	RATE_LIMITER_STORE: 'memory',
	RATE_LIMITER_POINTS: '2',
	RATE_LIMITER_DURATION: '60',
};

const GLOBAL_ENABLED = {
	RATE_LIMITER_ENABLED: 'true',
	RATE_LIMITER_STORE: 'memory',
	RATE_LIMITER_POINTS: '1',
	RATE_LIMITER_DURATION: '60',
	RATE_LIMITER_GLOBAL_ENABLED: 'true',
	RATE_LIMITER_GLOBAL_STORE: 'memory',
	RATE_LIMITER_GLOBAL_POINTS: '2',
	RATE_LIMITER_GLOBAL_DURATION: '60',
};

describe('consumeIpRateLimit', () => {
	it('returns allowed without consuming when the limiter is disabled', async () => {
		const { consumeIpRateLimit } = await loadIp({ RATE_LIMITER_ENABLED: 'false' });
		expect(await consumeIpRateLimit('1.1.1.1')).toEqual({ allowed: true });
	});

	it('shares one budget with the HTTP middleware, HTTP-then-helper', async () => {
		const { default: httpMiddleware, consumeIpRateLimit } = await loadIp(IP_ENABLED);

		await consumeViaHttp(httpMiddleware, '1.1.1.1');
		expect(await consumeIpRateLimit('1.1.1.1')).toEqual({ allowed: true });

		const third = await consumeIpRateLimit('1.1.1.1');
		expect(third.allowed).toBe(false);
		if (!third.allowed) expect(third.retryAfterMs).toBeGreaterThan(0);
	});

	it('shares one budget with the HTTP middleware, helper-then-HTTP', async () => {
		const { default: httpMiddleware, consumeIpRateLimit } = await loadIp(IP_ENABLED);

		expect(await consumeIpRateLimit('2.2.2.2')).toEqual({ allowed: true });
		await consumeViaHttp(httpMiddleware, '2.2.2.2');

		expect((await consumeIpRateLimit('2.2.2.2')).allowed).toBe(false);
	});
});

describe('consumeGlobalRateLimit', () => {
	it('returns allowed without consuming when the global limiter is disabled', async () => {
		const { consumeGlobalRateLimit } = await loadGlobal({ RATE_LIMITER_GLOBAL_ENABLED: 'false' });
		expect(await consumeGlobalRateLimit()).toEqual({ allowed: true });
	});

	it('shares one budget with the global HTTP middleware', async () => {
		const { default: httpMiddleware, consumeGlobalRateLimit } = await loadGlobal(GLOBAL_ENABLED);

		await consumeViaHttp(httpMiddleware, '3.3.3.3');
		expect(await consumeGlobalRateLimit()).toEqual({ allowed: true });

		const third = await consumeGlobalRateLimit();
		expect(third.allowed).toBe(false);
		if (!third.allowed) expect(third.retryAfterMs).toBeGreaterThan(0);
	});
});
