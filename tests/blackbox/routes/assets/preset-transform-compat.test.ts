import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import path from 'path';
import request from 'supertest';

jest.setTimeout(60000);

const imageFilePath = path.join(__dirname, '..', '..', 'assets', 'directus.png');

const blur = ['blur', 45];
const grayscale = ['grayscale'];
const extendRed = ['extend', { right: 500, background: 'rgb(255, 0, 0)' }];
const extendBlue = ['extend', { right: 500, background: 'rgb(0, 0, 255)' }];

function makePreset(key: string, transforms: unknown[]) {
	return {
		key,
		fit: null,
		width: null,
		height: null,
		quality: null,
		withoutEnlargement: null,
		format: null,
		transforms,
	};
}

function pngSize(buffer: Buffer): { width: number; height: number } {
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('/assets stored preset applies the shipped multi-op transform', () => {
	it.each(vendors)('%s', async (vendor) => {
		const auth = `Bearer ${common.USER.ADMIN.TOKEN}`;
		const url = getUrl(vendor);

		const runId = randomUUID();
		const fullKey = `sharp-compat-full-${runId}`;
		const noBlurKey = `sharp-compat-noblur-${runId}`;
		const noGrayKey = `sharp-compat-nogray-${runId}`;
		const blueKey = `sharp-compat-blue-${runId}`;
		const runKeys = [fullKey, noBlurKey, noGrayKey, blueKey];

		const before = await request(url).get('/settings?fields=storage_asset_presets').set('Authorization', auth);
		expect(before.statusCode).toBe(200);
		const originalPresets = before.body.data?.storage_asset_presets ?? null;

		let fileId: string | undefined;
		const cleanup: { settingsRead?: number; presetRestore?: number; fileDelete?: number } = {};

		try {
			const patch = await request(url)
				.patch('/settings')
				.set('Authorization', auth)
				.send({
					storage_asset_presets: [
						...(originalPresets ?? []),
						makePreset(fullKey, [blur, grayscale, extendRed]),
						makePreset(noBlurKey, [grayscale, extendRed]),
						makePreset(noGrayKey, [blur, extendRed]),
						makePreset(blueKey, [blur, grayscale, extendBlue]),
					],
				});

			expect(patch.statusCode).toBe(200);

			const upload = await request(url)
				.post('/files')
				.set('Authorization', auth)
				.field('storage', 'local')
				.attach('file', createReadStream(imageFilePath));

			expect(upload.statusCode).toBe(200);
			fileId = upload.body.data.id;

			const get = (key: string) => request(url).get(`/assets/${fileId}?key=${key}`).set('Authorization', auth);
			const full = await get(fullKey);
			const noBlur = await get(noBlurKey);
			const noGray = await get(noGrayKey);
			const blue = await get(blueKey);

			expect(full.statusCode).toBe(200);
			expect(full.headers['content-type']).toBe('image/png');
			expect(pngSize(full.body)).toEqual({ width: 1430, height: 200 });

			for (const control of [noBlur, noGray, blue]) expect(control.statusCode).toBe(200);
			expect(Buffer.compare(full.body, noBlur.body)).not.toBe(0);
			expect(Buffer.compare(full.body, noGray.body)).not.toBe(0);
			expect(Buffer.compare(full.body, blue.body)).not.toBe(0);
		} finally {
			const latest = await request(url).get('/settings?fields=storage_asset_presets').set('Authorization', auth);
			cleanup.settingsRead = latest.statusCode;

			const latestPresets = latest.body?.data?.storage_asset_presets;

			const hasRunKey =
				Array.isArray(latestPresets) && latestPresets.some((preset: { key: string }) => runKeys.includes(preset.key));

			if (latest.statusCode === 200 && hasRunKey) {
				const remaining = latestPresets.filter((preset: { key: string }) => !runKeys.includes(preset.key));
				const restoreValue = remaining.length === 0 && originalPresets === null ? null : remaining;

				const restore = await request(url)
					.patch('/settings')
					.set('Authorization', auth)
					.send({ storage_asset_presets: restoreValue });

				cleanup.presetRestore = restore.statusCode;
			}

			if (fileId) {
				const deletion = await request(url).delete(`/files/${fileId}`).set('Authorization', auth);
				cleanup.fileDelete = deletion.statusCode;
			}
		}

		expect(cleanup.settingsRead).toBe(200);
		expect(cleanup.presetRestore).toBe(200);
		expect([200, 204]).toContain(cleanup.fileDelete);
	});
});
