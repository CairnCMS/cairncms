import { describe, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createStorageTest } from '../../fixtures/storage';
import request from '../../fixtures/request';
import { withSettings } from '../../fixtures/settings';
import { createReadStream } from 'fs';
import path from 'path';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createStorageTest();

vi.setConfig({ testTimeout: 30000 });

initializeFixtures();

const assetsDirectory = [fileURLToPath(new URL('../../fixtures/assets/', import.meta.url))];
const storages = ['local', 's3'];

const imageFileAvif = path.join(...assetsDirectory, 'directus.avif');
const imageFilePng = path.join(...assetsDirectory, 'directus.png');

describe('/assets', () => {
	describe('GET /assets/:id', () => {
		describe('format=auto Tests', () => {
			describe('without Accept request header', () => {
				describe.each(storages)('Storage: %s', (storage) => {
					test('REST', async ({ api }) => {
						await withSettings(api, { storage_asset_transform: 'all' }, async () => {
							const insertResponse = await request(api.url)
								.post('/files')
								.set('Authorization', `Bearer ${api.adminToken}`)
								.field('storage', storage)
								.attach('file', createReadStream(imageFileAvif));

							const response = await request(api.url)
								.get(`/assets/${insertResponse.body.data.id}?format=auto`)
								.set('Authorization', `Bearer ${api.adminToken}`);

							expect(response.statusCode).toBe(200);
							expect(response.headers['content-type']).toBe('image/png'); // Expect fallback to png for image format with transparency support
						});
					});
				});
			});

			describe.each([
				{ requestHeaderAccept: 'image/avif,image/webp,image/*,*/*;q=0.8', responseHeaderContentType: 'image/avif' },
				{ requestHeaderAccept: 'image/avif', responseHeaderContentType: 'image/avif' },
				{ requestHeaderAccept: 'image/webp', responseHeaderContentType: 'image/webp' },
				{ requestHeaderAccept: '*/*', responseHeaderContentType: 'image/png' }, // Expect to return png as original image is png
			])('with "$requestHeaderAccept" Accept request header', ({ requestHeaderAccept, responseHeaderContentType }) => {
				describe.each(storages)('Storage: %s', (storage) => {
					test('REST', async ({ api }) => {
						await withSettings(api, { storage_asset_transform: 'all' }, async () => {
							const insertResponse = await request(api.url)
								.post('/files')
								.set('Authorization', `Bearer ${api.adminToken}`)
								.field('storage', storage)
								.attach('file', createReadStream(imageFilePng));

							const response = await request(api.url)
								.get(`/assets/${insertResponse.body.data.id}?format=auto`)
								.set('Authorization', `Bearer ${api.adminToken}`)
								.set('Accept', requestHeaderAccept);

							expect(response.statusCode).toBe(200);
							expect(response.headers['content-type']).toBe(responseHeaderContentType);
						});
					});
				});
			});
		});
	});
});
