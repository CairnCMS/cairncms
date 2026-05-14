import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { Readable } from 'node:stream';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

const { getAssetSpy, statAssetSpy } = vi.hoisted(() => ({
	getAssetSpy: vi.fn(),
	statAssetSpy: vi.fn(),
}));

vi.mock('../services/assets.js', () => {
	const AssetsService = vi.fn();
	AssetsService.prototype.getAsset = getAssetSpy;
	AssetsService.prototype.statAsset = statAssetSpy;
	return { AssetsService };
});

vi.mock('../services/payload.js', () => {
	const PayloadService = vi.fn();
	PayloadService.prototype.processValues = vi.fn(async () => undefined);
	return { PayloadService };
});

vi.mock('../database/index.js', () => ({
	default: () => ({
		select: () => ({
			from: () => ({
				first: async () => undefined,
			}),
		}),
	}),
}));

vi.mock('../env.js', () => {
	const MOCK_ENV = {
		ASSETS_CACHE_TTL: '30d',
		ASSETS_TRANSFORM_MAX_OPERATIONS: 5,
		ASSETS_CONTENT_SECURITY_POLICY: {},
		ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION: 6000,
		ASSETS_TRANSFORM_MAX_CONCURRENT: 25,
		ASSETS_TRANSFORM_TIMEOUT: '7500ms',
		ASSETS_INVALID_IMAGE_SENSITIVITY_LEVEL: 'warning',
		REFRESH_TOKEN_COOKIE_NAME: 'cairncms_refresh_token',
	};

	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

vi.mock('../middleware/extract-cookie-session.js', () => ({
	default: (_req: any, _res: any, next: any) => next(),
}));

import assetsRouter from './assets.js';

function buildApp() {
	const app = express();

	app.use((req: Request, _res: Response, next: NextFunction) => {
		(req as any).accountability = {
			user: 'admin-uuid',
			role: 'role-uuid',
			admin: true,
			app: true,
			ip: '127.0.0.1',
			permissions: [],
		};

		(req as any).schema = { collections: {}, relations: [] };
		next();
	});

	app.use('/assets', assetsRouter);
	return app;
}

function fakeFile() {
	return {
		id: VALID_UUID,
		filename_disk: `${VALID_UUID}.jpg`,
		filename_download: 'photo.jpg',
		type: 'image/jpeg',
		filesize: 1024,
		width: 800,
		height: 600,
		modified_on: '2026-05-13T00:00:00.000Z',
		storage: 's3',
	};
}

describe('GET/HEAD /assets/:pk (GHSA-rv78-qqrq-73m5)', () => {
	beforeEach(() => {
		getAssetSpy.mockReset().mockResolvedValue({
			stream: Readable.from(Buffer.from('test-body')),
			file: fakeFile(),
			stat: { size: 9 },
		});

		statAssetSpy.mockReset().mockResolvedValue({
			file: fakeFile(),
			stat: { size: 1024 },
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('HEAD request', () => {
		it('does not invoke AssetsService.getAsset', async () => {
			const app = buildApp();

			const res = await request(app).head(`/assets/${VALID_UUID}`);

			expect(res.status).toBe(200);
			expect(getAssetSpy).not.toHaveBeenCalled();
			expect(statAssetSpy).toHaveBeenCalledWith(VALID_UUID, expect.anything(), undefined);
		});

		it('omits Content-Length when statAsset returns stat: null (uncached transform)', async () => {
			statAssetSpy.mockResolvedValue({
				file: { ...fakeFile(), type: 'image/avif' },
				stat: null,
			});

			const app = buildApp();
			const res = await request(app).head(`/assets/${VALID_UUID}?width=313&format=avif`);

			expect(res.status).toBe(200);
			expect(res.headers['content-length']).toBeUndefined();
			expect(res.headers['content-type']).toBe('image/avif');
			expect(getAssetSpy).not.toHaveBeenCalled();
		});
	});

	describe('GET request (regression)', () => {
		it('invokes AssetsService.getAsset', async () => {
			const app = buildApp();

			const res = await request(app).get(`/assets/${VALID_UUID}`);

			expect(res.status).toBe(200);
			expect(getAssetSpy).toHaveBeenCalledWith(VALID_UUID, expect.anything(), undefined);
			expect(statAssetSpy).not.toHaveBeenCalled();
		});
	});
});
