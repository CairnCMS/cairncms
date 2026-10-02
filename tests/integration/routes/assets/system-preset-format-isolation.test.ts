import { describe, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createStorageTest } from '../../fixtures/storage';
import { createReadStream } from 'fs';
import path from 'path';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createStorageTest();

vi.setConfig({ testTimeout: 30000 });

initializeFixtures();

const assetsDirectory = [fileURLToPath(new URL('../../../blackbox/assets/', import.meta.url))];
const storages = ['local', 's3'];

const imageFile = {
	name: 'directus.png',
	type: 'image/png',
};

const imageFilePath = path.join(...assetsDirectory, imageFile.name);

describe('/assets system-preset format negotiation isolation', () => {
	describe('Two sequential requests for the same system preset with different Accept headers get independent format negotiation', () => {
		describe.each(storages)('Storage: %s', (storage) => {
			test('REST', async ({ api }) => {
				const insertResponse = await request(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', storage)
					.attach('file', createReadStream(imageFilePath));

				const fileId = insertResponse.body.data.id;

				const webpResponse = await request(api.url)
					.get(`/assets/${fileId}?key=system-medium-contain`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.set('Accept', 'image/webp');

				expect(webpResponse.statusCode).toBe(200);
				expect(webpResponse.headers['content-type']).toBe('image/webp');

				const avifResponse = await request(api.url)
					.get(`/assets/${fileId}?key=system-medium-contain`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.set('Accept', 'image/avif');

				expect(avifResponse.statusCode).toBe(200);
				expect(avifResponse.headers['content-type']).toBe('image/avif');

				const ping = await request(api.url).get('/server/ping');

				expect(ping.statusCode).toBe(200);
				expect(ping.text).toBe('pong');
			});
		});
	});
});
