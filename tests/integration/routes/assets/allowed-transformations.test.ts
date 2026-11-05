import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type supertest from 'supertest';
import { describe, expect } from 'vitest';
import { apiTest as test, type Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const imageFilePath = fileURLToPath(new URL('../../fixtures/assets/directus.png', import.meta.url));

const thumbPreset = {
	key: 'project-thumb',
	fit: 'cover',
	width: 100,
	height: 100,
	quality: null,
	withoutEnlargement: null,
	format: null,
	transforms: [],
};

function pngSize(buffer: Buffer): { width: number; height: number } {
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Runs a case under one transformation mode against a fresh upload, then restores the settings and removes the file. */
async function withTransformMode(
	api: Api,
	mode: 'all' | 'presets' | 'none',
	run: (get: (query: string) => Promise<supertest.Response>) => Promise<void>
) {
	const auth = `Bearer ${api.adminToken}`;

	const before = await setupRequest(api.url)
		.get('/settings?fields=storage_asset_transform,storage_asset_presets')
		.set('Authorization', auth);

	const original = {
		storage_asset_transform: before.body.data.storage_asset_transform ?? null,
		storage_asset_presets: before.body.data.storage_asset_presets ?? null,
	};

	const cleanup: { fileDelete?: number; settingsRestore?: number } = {};
	let fileId: string | undefined;

	try {
		await setupRequest(api.url)
			.patch('/settings')
			.set('Authorization', auth)
			.send({ storage_asset_transform: mode, storage_asset_presets: [thumbPreset] });

		const upload = await setupRequest(api.url)
			.post('/files')
			.set('Authorization', auth)
			.field('storage', 'local')
			.attach('file', createReadStream(imageFilePath));

		fileId = upload.body.data.id;

		await run((query) => request(api.url).get(`/assets/${fileId}${query}`).set('Authorization', auth));
	} finally {
		if (fileId) {
			cleanup.fileDelete = (await request(api.url).delete(`/files/${fileId}`).set('Authorization', auth)).statusCode;
		}

		cleanup.settingsRestore = (
			await request(api.url).patch('/settings').set('Authorization', auth).send(original)
		).statusCode;
	}

	expect([200, 204]).toContain(cleanup.fileDelete);
	expect(cleanup.settingsRestore).toBe(200);
}

describe('/assets allowed transformations with an empty transforms list', () => {
	test('limiting to presets rejects resize parameters that carry an empty transforms list', async ({ api }) => {
		await withTransformMode(api, 'presets', async (get) => {
			const bypass = await get('?width=100&transforms=[]');
			expect(bypass.statusCode).toBe(400);
			expect(bypass.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const resize = await get('?width=100');
			expect(resize.statusCode).toBe(400);

			const original = await get('');
			const emptyList = await get('?transforms=[]');
			expect(original.statusCode).toBe(200);
			expect(emptyList.statusCode).toBe(200);
			expect(Buffer.compare(emptyList.body, original.body)).toBe(0);

			const preset = await get(`?key=${thumbPreset.key}`);
			expect(preset.statusCode).toBe(200);
			expect(pngSize(preset.body)).toEqual({ width: 100, height: 100 });
		});
	});

	test('disabling transformations rejects resize parameters that carry an empty transforms list', async ({ api }) => {
		await withTransformMode(api, 'none', async (get) => {
			const bypass = await get('?width=100&transforms=[]');
			expect(bypass.statusCode).toBe(400);
			expect(bypass.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const projectPreset = await get(`?key=${thumbPreset.key}`);
			expect(projectPreset.statusCode).toBe(400);

			const systemSize = await get('?key=system-small-cover');
			expect(systemSize.statusCode).toBe(200);
			expect(pngSize(systemSize.body)).toEqual({ width: 64, height: 64 });

			const original = await get('');
			const emptyList = await get('?transforms=[]');
			expect(emptyList.statusCode).toBe(200);
			expect(Buffer.compare(emptyList.body, original.body)).toBe(0);
		});
	});

	test('allowing all transformations still resizes with an empty transforms list', async ({ api }) => {
		await withTransformMode(api, 'all', async (get) => {
			const resized = await get('?width=100&transforms=[]');
			expect(resized.statusCode).toBe(200);
			expect(pngSize(resized.body).width).toBe(100);
		});
	});
});
