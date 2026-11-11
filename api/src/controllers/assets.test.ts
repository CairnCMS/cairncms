import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { PassThrough, Readable } from 'node:stream';
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

const ADMIN_ACCOUNTABILITY = {
	user: 'admin-uuid',
	role: 'role-uuid',
	admin: true,
	app: true,
	ip: '127.0.0.1',
	permissions: [],
};

const EMPTY_SCHEMA = { collections: {}, relations: [] };

function settingsSchema(defaults: Record<string, unknown>) {
	const fields = Object.fromEntries(
		Object.entries(defaults).map(([field, defaultValue]) => [field, { field, defaultValue }])
	);

	return { collections: { directus_settings: { fields } }, relations: [] };
}

function buildApp(
	accountability: Record<string, unknown> = ADMIN_ACCOUNTABILITY,
	schema: Record<string, unknown> = EMPTY_SCHEMA
) {
	const app = express();

	app.use((req: Request, _res: Response, next: NextFunction) => {
		(req as any).accountability = accountability;
		(req as any).schema = schema;
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
		savedSettings.row = { storage_asset_presets: [], storage_asset_transform: 'all' };

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
		savedSettings.row = undefined;
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

describe('GET /assets/:pk stream ownership', () => {
	beforeEach(() => {
		savedSettings.row = { storage_asset_presets: [], storage_asset_transform: 'all' };
	});

	afterEach(() => {
		savedSettings.row = undefined;
		vi.clearAllMocks();
	});

	it('destroys the asset stream when the response headers cannot be set', async () => {
		const stream = new PassThrough();

		getAssetSpy.mockReset().mockResolvedValue({
			stream,
			file: { ...fakeFile(), type: 'image/png\u0001' },
			stat: { size: 9 },
		});

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}`);

		expect(res.status).toBe(500);
		expect(stream.destroyed).toBe(true);
	});

	it('ends the response when the asset stream fails after data was sent', async () => {
		let reads = 0;

		const stream = new Readable({
			read() {
				reads++;

				if (reads === 1) {
					this.push(Buffer.from('partial'));
				} else {
					setImmediate(() => this.destroy(new Error('storage connection lost')));
				}
			},
		});

		getAssetSpy.mockReset().mockResolvedValue({ stream, file: fakeFile(), stat: { size: 1024 } });

		const outcome = await request(buildApp())
			.get(`/assets/${VALID_UUID}`)
			.timeout(2000)
			.then(
				() => 'completed',
				(error) => {
					if (error.timeout) return 'timed out';
					if (error.code === 'ECONNRESET' && error.message === 'aborted') return 'aborted';
					return `failed: ${error.name}: ${error.message}`;
				}
			);

		expect(outcome).toBe('aborted');
	});

	it('returns the structured error when the asset stream fails before any data', async () => {
		const stream = new Readable({
			read() {
				this.destroy(new Error('storage read failed'));
			},
		});

		getAssetSpy.mockReset().mockResolvedValue({ stream, file: fakeFile(), stat: { size: 9 } });

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}`);

		expect(res.status).toBe(500);
		expect(res.body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
	});

	it('serves the asset body on success', async () => {
		getAssetSpy.mockReset().mockResolvedValue({
			stream: Readable.from(Buffer.from('test-body')),
			file: { ...fakeFile(), type: 'text/plain' },
			stat: { size: 9 },
		});

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}`);

		expect(res.status).toBe(200);
		expect(res.text).toBe('test-body');
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

describe('GET /assets/:pk advanced transformations', () => {
	const thumbPreset = { key: 'thumb', width: 100, height: 100, fit: 'cover' };
	const blur = `transforms=${encodeURIComponent(JSON.stringify([['blur', 1]]))}`;

	const ANONYMOUS = { user: null, role: null, admin: false, app: false, ip: '127.0.0.1' };
	const SHARE = { ...ANONYMOUS, role: 'share-role-uuid', share: 'share-uuid', share_scope: {} };
	const API_USER = { user: 'user-uuid', role: 'api-role-uuid', admin: false, app: false, ip: '127.0.0.1' };

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

	function useSettings(mode: string, publicTransforms: unknown) {
		savedSettings.row = {
			storage_asset_presets: [thumbPreset],
			storage_asset_transform: mode,
			storage_asset_public_transforms: publicTransforms,
		};
	}

	it.each([
		['an anonymous caller', ANONYMOUS],
		['a share link', SHARE],
	])('rejects them for %s when public advanced transformations are off', async (_label, accountability) => {
		useSettings('all', false);

		const res = await request(buildApp(accountability)).get(`/assets/${VALID_UUID}?${blur}`);

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 'INVALID_QUERY' });
		expect(getAssetSpy).not.toHaveBeenCalled();
	});

	it('rejects them for an anonymous caller when no settings row exists and the schema allows all', async () => {
		const schema = settingsSchema({ storage_asset_transform: 'all' });

		const res = await request(buildApp(ANONYMOUS, schema)).get(`/assets/${VALID_UUID}?${blur}`);

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 'INVALID_QUERY' });
		expect(getAssetSpy).not.toHaveBeenCalled();
	});

	it('follows the schema default for public advanced transformations when no settings row exists', async () => {
		const schema = settingsSchema({ storage_asset_transform: 'all', storage_asset_public_transforms: true });

		const res = await request(buildApp(ANONYMOUS, schema)).get(`/assets/${VALID_UUID}?${blur}`);

		expect(res.status).toBe(200);
		expect(getAssetSpy).toHaveBeenCalledTimes(1);
	});

	it.each([
		['resize parameters', 'width=100'],
		['a configured preset', 'key=thumb'],
		['an empty transforms list', 'transforms=[]'],
	])('lets an anonymous caller use %s when public advanced transformations are off', async (_label, query) => {
		useSettings('all', false);

		const res = await request(buildApp(ANONYMOUS)).get(`/assets/${VALID_UUID}?${query}`);

		expect(res.status).toBe(200);
		expect(getAssetSpy).toHaveBeenCalledTimes(1);
	});

	it('allows them for a user without app access', async () => {
		useSettings('all', false);

		const res = await request(buildApp(API_USER)).get(`/assets/${VALID_UUID}?${blur}`);

		expect(res.status).toBe(200);
		expect(getAssetSpy.mock.calls[0]![1].transformationParams.transforms).toEqual([['blur', 1]]);
	});

	it('allows them for an anonymous caller when public advanced transformations are on', async () => {
		useSettings('all', true);

		const res = await request(buildApp(ANONYMOUS)).get(`/assets/${VALID_UUID}?${blur}`);

		expect(res.status).toBe(200);
		expect(getAssetSpy).toHaveBeenCalledTimes(1);
	});

	it.each(['presets', 'none'])('rejects them for an admin under %s whatever the switch value', async (mode) => {
		useSettings(mode, true);

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?${blur}`);

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 'INVALID_QUERY' });
		expect(getAssetSpy).not.toHaveBeenCalled();
	});
});

describe('GET /assets/:pk without a settings row', () => {
	beforeEach(() => {
		savedSettings.row = undefined;

		getAssetSpy.mockReset().mockResolvedValue({
			stream: Readable.from(Buffer.from('test-body')),
			file: fakeFile(),
			stat: { size: 9 },
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('allows transformations when the schema default is all', async () => {
		const schema = settingsSchema({ storage_asset_transform: 'all' });

		const res = await request(buildApp(ADMIN_ACCOUNTABILITY, schema)).get(`/assets/${VALID_UUID}?width=100`);

		expect(res.status).toBe(200);
		expect(getAssetSpy.mock.calls[0]![1].transformationParams.width).toBe('100');
	});

	it.each([
		['the schema default is none', settingsSchema({ storage_asset_transform: 'none' })],
		['the schema reports no default', settingsSchema({ storage_asset_transform: null })],
		['the schema has no settings collection', EMPTY_SCHEMA],
	])('disables transformations when %s', async (_label, schema) => {
		const res = await request(buildApp(ADMIN_ACCOUNTABILITY, schema)).get(`/assets/${VALID_UUID}?width=100`);

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 'INVALID_QUERY' });
		expect(getAssetSpy).not.toHaveBeenCalled();
	});

	it('still serves system keys when the schema reports no default', async () => {
		const schema = settingsSchema({ storage_asset_transform: null });

		const res = await request(buildApp(ADMIN_ACCOUNTABILITY, schema)).get(
			`/assets/${VALID_UUID}?key=system-small-cover`
		);

		expect(res.status).toBe(200);
		expect(getAssetSpy).toHaveBeenCalledTimes(1);
	});
});

describe('GET /assets/:pk Kanban card size', () => {
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

	it.each(['all', 'presets', 'none'])('resolves the built-in 250x150 cover under %s', async (mode) => {
		savedSettings.row = { storage_asset_presets: [], storage_asset_transform: mode };

		const res = await request(buildApp()).get(`/assets/${VALID_UUID}?key=system-kanban-cover`);

		expect(res.status).toBe(200);

		expect(getAssetSpy.mock.calls[0]![1].transformationParams).toEqual({
			key: 'system-kanban-cover',
			format: 'auto',
			transforms: [['resize', { width: 250, height: 150, fit: 'cover' }]],
		});
	});
});
