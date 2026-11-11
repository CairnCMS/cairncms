import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type supertest from 'supertest';
import { describe, expect } from 'vitest';
import { apiTest as test, type Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const imageFilePath = fileURLToPath(new URL('../../fixtures/assets/directus.png', import.meta.url));

function pngSize(buffer: Buffer): { width: number; height: number } {
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Runs a case against a fresh upload, then removes the file and any settings row, returning the database to the state
 * a new installation starts in.
 */
async function withUpload(api: Api, run: (get: (query: string) => Promise<supertest.Response>) => Promise<void>) {
	const auth = `Bearer ${api.adminToken}`;
	const cleanup: { fileDelete?: number } = {};
	let fileId: string | undefined;

	try {
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

		await api.database('directus_settings').delete();
	}

	expect([200, 204]).toContain(cleanup.fileDelete);
}

async function readTransformSettings(api: Api) {
	const response = await setupRequest(api.url)
		.get('/settings')
		.query({ fields: 'storage_asset_transform,storage_asset_public_transforms' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	return response.body.data;
}

describe('/assets on a new installation', () => {
	test('disables transformations before a settings row exists', async ({ api }) => {
		expect(await api.database('directus_settings').first()).toBeUndefined();

		await withUpload(api, async (get) => {
			expect(await readTransformSettings(api)).toEqual({
				storage_asset_transform: 'none',
				storage_asset_public_transforms: false,
			});

			const resize = await get('?width=100');
			expect(resize.statusCode).toBe(400);
			expect(resize.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const systemKey = await get('?key=system-small-cover');
			expect(systemKey.statusCode).toBe(200);
			expect(pngSize(systemKey.body)).toEqual({ width: 64, height: 64 });

			expect(await api.database('directus_settings').first()).toBeUndefined();
		});
	});

	test('disables transformations when the first settings row is created', async ({ api }) => {
		await withUpload(api, async (get) => {
			await setupRequest(api.url)
				.patch('/settings')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({ project_name: 'New installation' });

			const row = await api.database('directus_settings').first();
			expect(row.storage_asset_transform).toBe('none');
			expect(Boolean(row.storage_asset_public_transforms)).toBe(false);

			expect(await readTransformSettings(api)).toEqual({
				storage_asset_transform: 'none',
				storage_asset_public_transforms: false,
			});

			const resize = await get('?width=100');
			expect(resize.statusCode).toBe(400);
			expect(resize.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const systemKey = await get('?key=system-small-cover');
			expect(systemKey.statusCode).toBe(200);
			expect(pngSize(systemKey.body)).toEqual({ width: 64, height: 64 });
		});
	});
});
