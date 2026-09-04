import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setCacheValueMock = vi.fn();
const getCacheValueMock = vi.fn();
const fakeCache = {} as any;

vi.mock('../cache.js', () => ({
	getCache: () => ({ cache: fakeCache, systemCache: fakeCache, sharedSchemaCache: fakeCache }),
	getCacheValue: (...args: unknown[]) => getCacheValueMock(...args),
	setCacheValue: (...args: unknown[]) => setCacheValueMock(...args),
}));

vi.mock('../env.js', () => {
	const MOCK_ENV = {
		CACHE_ENABLED: true,
		CACHE_STATUS_HEADER: false,
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

const { getCacheKeyMock } = vi.hoisted(() => ({
	getCacheKeyMock: vi.fn((originalUrl: string) => `key:${originalUrl}`),
}));

vi.mock('../utils/get-cache-key.js', () => ({
	getCacheKey: (req: Request) => getCacheKeyMock(req.originalUrl),
}));

vi.mock('../utils/should-skip-cache.js', () => ({
	shouldSkipCache: () => false,
}));

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import checkCacheMiddleware from './cache.js';
import { respond } from './respond.js';

function makeReqRes(originalUrl: string) {
	const headers: Record<string, string> = {};

	const req = {
		method: 'GET',
		originalUrl,
		path: originalUrl.split('?')[0],
		sanitizedQuery: {},
		accountability: null,
		get: () => undefined,
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

describe('cache read + respond chain — fail closed', () => {
	beforeEach(() => {
		setCacheValueMock.mockReset();
		getCacheValueMock.mockReset();
		getCacheKeyMock.mockClear();
	});

	it('a read-path key failure yields one getCacheKey call and zero writes across the chain', async () => {
		getCacheKeyMock.mockImplementationOnce(() => {
			throw new Error('unhashable');
		});

		const { req, res } = makeReqRes('/items/articles');

		await (checkCacheMiddleware as any)(req, res, vi.fn());
		await (respond as any)(req, res, vi.fn());

		expect(getCacheKeyMock).toHaveBeenCalledOnce();
		expect(setCacheValueMock).not.toHaveBeenCalled();
		expect((res.locals as any).cache).toBe(false);
	});
});
