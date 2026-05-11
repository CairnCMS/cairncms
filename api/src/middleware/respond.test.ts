import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setCacheValueMock = vi.fn();
const fakeCache = {} as any;

vi.mock('../cache.js', () => ({
	getCache: () => ({ cache: fakeCache, systemCache: fakeCache, sharedSchemaCache: fakeCache }),
	setCacheValue: (...args: unknown[]) => setCacheValueMock(...args),
}));

vi.mock('../env.js', () => {
	const MOCK_ENV = {
		CACHE_ENABLED: true,
		CACHE_TTL: '5m',
		CACHE_VALUE_MAX_SIZE: false,
		CACHE_AUTO_PURGE: false,
		CACHE_CONTROL_S_MAXAGE: '0',
		EXTENSIONS_PATH: './extensions',
		EMAIL_TRANSPORT: 'sendmail',
	};

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

vi.mock('../utils/get-cache-key.js', () => ({
	getCacheKey: (req: Request) => `key:${req.originalUrl}`,
}));

import { respond } from './respond.js';

function makeReqRes(originalUrl: string, method = 'GET') {
	const headers: Record<string, string> = {};

	const req = {
		method,
		originalUrl,
		sanitizedQuery: {},
		accountability: null,
	} as unknown as Request;

	const res = {
		locals: { payload: { data: { ok: true } } } as Record<string, unknown>,
		setHeader: (name: string, value: string) => {
			headers[name.toLowerCase()] = value;
		},
		json: vi.fn().mockReturnThis(),
		status: vi.fn().mockReturnThis(),
		end: vi.fn().mockReturnThis(),
	} as unknown as Response;

	return { req, res, headers };
}

describe('respond middleware — auth path cache exclusion', () => {
	afterEach(() => {
		setCacheValueMock.mockReset();
	});

	it('does not cache GET /auth/* responses and emits Cache-Control: no-cache', async () => {
		const { req, res, headers } = makeReqRes('/auth/login/openid/callback');
		await (respond as any)(req, res, vi.fn());

		expect(setCacheValueMock).not.toHaveBeenCalled();
		expect(headers['cache-control']).toBe('no-cache');
	});

	it('does not cache the bare GET /auth response either', async () => {
		const { req, res, headers } = makeReqRes('/auth');
		await (respond as any)(req, res, vi.fn());

		expect(setCacheValueMock).not.toHaveBeenCalled();
		expect(headers['cache-control']).toBe('no-cache');
	});

	it('caches a non-/auth GET response and emits a TTL-based Cache-Control', async () => {
		const { req, res, headers } = makeReqRes('/server/info');
		await (respond as any)(req, res, vi.fn());

		expect(setCacheValueMock).toHaveBeenCalled();
		expect(headers['cache-control']).not.toBe('no-cache');
	});
});
