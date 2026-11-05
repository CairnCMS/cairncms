import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { Readable } from 'node:stream';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

const { getAssetSpy, statAssetSpy, savedSettings } = vi.hoisted(() => ({
	getAssetSpy: vi.fn(),
	statAssetSpy: vi.fn(),
	savedSettings: { row: undefined as Record<string, unknown> | undefined },
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
				first: async () => savedSettings.row,
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

	app.use((err: { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
		res.status(err.status ?? 500).json({ code: err.code });
	});

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

	describe('transformation set threading', () => {
		const expectedSet = {
			transformationParams: { format: 'auto', width: '100' },
			acceptFormat: 'avif',
		};

		it('passes the resolved TransformationSet to statAsset on HEAD', async () => {
			const app = buildApp();

			await request(app).head(`/assets/${VALID_UUID}?format=auto&width=100`).set('Accept', 'image/avif');

			expect(statAssetSpy).toHaveBeenCalledWith(VALID_UUID, expectedSet, undefined);
		});

		it('passes the identical TransformationSet to getAsset on GET', async () => {
			const app = buildApp();

			await request(app).get(`/assets/${VALID_UUID}?format=auto&width=100`).set('Accept', 'image/avif');

			expect(getAssetSpy).toHaveBeenCalledWith(VALID_UUID, expectedSet, undefined);
		});

		it('leaves acceptFormat undefined when the client advertises no modern format', async () => {
			const app = buildApp();

			await request(app).get(`/assets/${VALID_UUID}?format=auto`).set('Accept', '*/*');

			expect(getAssetSpy).toHaveBeenCalledWith(
				VALID_UUID,
				{ transformationParams: { format: 'auto' }, acceptFormat: undefined },
				undefined
			);
		});

		it('adds Accept to the Vary header on auto-format requests', async () => {
			const app = buildApp();

			const res = await request(app).get(`/assets/${VALID_UUID}?format=auto`).set('Accept', '*/*');

			expect(res.headers['vary']).toContain('Accept');
		});
	});
});

describe('GET /assets/:pk allowed transformations with an empty transforms list', () => {
	const thumbPreset = { key: 'thumb', width: 100, height: 100, fit: 'cover' };

	beforeEach(() => {
		getAssetSpy.mockReset().mockResolvedValue({
			stream: Readable.from(Buffer.from('test-body')),
			file: fakeFile(),
			stat: { size: 9 },
		});
	});

	afterEach(() => {
		savedSettings.row = undefined;
		vi.clearAllMocks();
	});

	function useTransformMode(mode: string) {
		savedSettings.row = { storage_asset_presets: [thumbPreset], storage_asset_transform: mode };
	}

	it.each(['presets', 'none'])('rejects width with an empty transforms list under %s', async (mode) => {
		useTransformMode(mode);

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?width=100&transforms=[]`);

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 'INVALID_QUERY' });
		expect(getAssetSpy).not.toHaveBeenCalled();
	});

	it.each(['presets', 'none'])('serves the original for a bare empty transforms list under %s', async (mode) => {
		useTransformMode(mode);

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?transforms=[]`);

		expect(res.status).toBe(200);
		expect(getAssetSpy).toHaveBeenCalledTimes(1);

		const { transformationParams } = getAssetSpy.mock.calls[0]![1];
		expect(transformationParams.width).toBeUndefined();
		expect(transformationParams.height).toBeUndefined();
		expect(transformationParams.transforms ?? []).toEqual([]);
	});

	it('rejects width without a transforms list under presets', async () => {
		useTransformMode('presets');

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?width=100`);

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 'INVALID_QUERY' });
		expect(getAssetSpy).not.toHaveBeenCalled();
	});

	it('serves a configured preset key under presets', async () => {
		useTransformMode('presets');

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?key=thumb`);

		expect(res.status).toBe(200);

		expect(getAssetSpy).toHaveBeenCalledWith(
			VALID_UUID,
			expect.objectContaining({ transformationParams: thumbPreset }),
			undefined
		);
	});

	it('still passes width with an empty transforms list under all', async () => {
		useTransformMode('all');

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?width=100&transforms=[]`);

		expect(res.status).toBe(200);
		expect(getAssetSpy).toHaveBeenCalledTimes(1);
		expect(getAssetSpy.mock.calls[0]![1].transformationParams.width).toBe('100');
	});
});
