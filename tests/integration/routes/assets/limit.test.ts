import { describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createStorageTest } from '../../fixtures/storage';
import request from '../../fixtures/request';
import { createReadStream } from 'fs';
import path from 'path';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const ASSET_CONCURRENCY = 2;

const test = createStorageTest({ env: { ASSETS_TRANSFORM_MAX_CONCURRENT: String(ASSET_CONCURRENCY) } });

initializeFixtures();

const assetsDirectory = [fileURLToPath(new URL('../../fixtures/assets/', import.meta.url))];
const storages = ['local', 's3'];

const imageFile = {
	name: 'directus.png',
	type: 'image/png',
	filesize: '7136',
};

const imageFilePath = path.join(...assetsDirectory, imageFile.name);

describe('/assets', () => {
	describe('GET /assets/:id', () => {
		describe('ASSETS_TRANSFORM_MAX_CONCURRENT Tests', () => {
			describe('passes when below limit', () => {
				describe.each(storages)('Storage: %s', (storage) => {
					test('REST', async ({ api }) => {
						// Setup
						const count = ASSET_CONCURRENCY;

						const uploadedFileID = (
							await request(api.url)
								.post('/files')
								.set('Authorization', `Bearer ${api.adminToken}`)
								.field('storage', storage)
								.attach('file', createReadStream(imageFilePath))
						).body.data.id;

						// Action
						const responses = await Promise.all(
							Array(count)
								.fill(0)
								.map((_, index) =>
									request(api.url)
										.get(`/assets/${uploadedFileID}?width=${4000 + index}&height=${4000 + index}`)
										.timeout({ response: 60000, deadline: 60000 })
										.set('Authorization', `Bearer ${api.adminToken}`)
								)
						);

						// Assert
						for (const response of responses) {
							expect(response.statusCode).toBe(200);
						}
					}, 60000);
				});
			});

			describe('errors when above limit', () => {
				describe.each(storages)('Storage: %s', (storage) => {
					test('REST', async ({ api }) => {
						// Setup
						const attempts = 100;

						const uploadedFileID = (
							await request(api.url)
								.post('/files')
								.set('Authorization', `Bearer ${api.adminToken}`)
								.field('storage', storage)
								.attach('file', createReadStream(imageFilePath))
						).body.data.id;

						// Action
						const responses = await Promise.all(
							Array(attempts)
								.fill(0)
								.map((_, index) =>
									request(api.url)
										.get(`/assets/${uploadedFileID}?width=${4000 + index}&height=${4000 + index}`)
										.timeout({ response: 1200000, deadline: 1200000 })
										.set('Authorization', `Bearer ${api.adminToken}`)
								)
						);

						// Assert
						const unavailableCount = responses.filter((response) => response.statusCode === 503).length;
						expect(unavailableCount).toBeGreaterThanOrEqual(1);

						expect(responses.filter((response) => response.statusCode === 200).length).toBe(
							attempts - unavailableCount
						);
					}, 1200000);
				});
			});
		});
	});
});
