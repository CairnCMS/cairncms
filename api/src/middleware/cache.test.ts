import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCacheValueMock = vi.fn();
const fakeCache = {} as any;

vi.mock('../cache.js', () => ({
	getCache: () => ({ cache: fakeCache }),
	getCacheValue: (...args: unknown[]) => getCacheValueMock(...args),
}));

vi.mock('../env.js', () => {
	const MOCK_ENV = {
		CACHE_ENABLED: true,
		CACHE_STATUS_HEADER: false,
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

function makeReqRes(originalUrl: string, method = 'GET') {
	const req = { method, originalUrl, path: originalUrl.split('?')[0] } as unknown as Request;

	const res = {
		locals: {} as Record<string, unknown>,
		setHeader: vi.fn(),
		json: vi.fn().mockReturnThis(),
	} as unknown as Response;

	return { req, res };
}

describe('cache middleware — read-path key stashing and fail-closed', () => {
	beforeEach(() => {
		getCacheKeyMock.mockClear();
		getCacheValueMock.mockReset();
	});

	it('stashes the computed key on res.locals for reuse on a miss', async () => {
		getCacheValueMock.mockResolvedValue(undefined);
		const { req, res } = makeReqRes('/items/articles');
		const next = vi.fn();

		await (checkCacheMiddleware as any)(req, res, next);

		expect((res.locals as any).cacheKey).toBe('key:/items/articles');
		expect(next).toHaveBeenCalledOnce();
	});

	it('fails closed to a miss without a 500 when the key cannot be computed', async () => {
		getCacheKeyMock.mockImplementationOnce(() => {
			throw new Error('unhashable');
		});

		const { req, res } = makeReqRes('/items/articles');
		const next = vi.fn();

		await (checkCacheMiddleware as any)(req, res, next);

		expect((res.locals as any).cache).toBe(false);
		expect(getCacheValueMock).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledOnce();
		expect(next).not.toHaveBeenCalledWith(expect.any(Error));
	});

	it('skips the cache read for /server/info so a preloaded entry is never served stale', async () => {
		getCacheValueMock.mockResolvedValue({ cached: 'stale' });
		const { req, res } = makeReqRes('/server/info');
		const next = vi.fn();

		await (checkCacheMiddleware as any)(req, res, next);

		expect(getCacheValueMock).not.toHaveBeenCalled();
		expect((res.locals as any).cacheKey).toBeUndefined();
		expect(res.json).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledOnce();
	});
});
