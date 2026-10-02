import { describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createStorageTest } from '../../fixtures/storage';
import request from '../../fixtures/request';
import { createReadStream, readFileSync } from 'fs';
import path from 'path';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createStorageTest();

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
		describe.each(storages)('Storage: %s', (storage) => {
			test('REST', async ({ api }) => {
				// Setup
				const insertResponse = await request(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', storage)
					.attach('file', createReadStream(imageFilePath));

				// Action
				const response = await request(api.url)
					.get(`/assets/${insertResponse.body.data.id}`)
					.set('Authorization', `Bearer ${api.adminToken}`);

				// Assert
				expect(response.statusCode).toBe(200);
				expect(response.headers['content-type']).toBe(imageFile.type);
				expect(response.headers['content-length']).toBe(imageFile.filesize);
				expect(Buffer.compare(response.body, await readFileSync(imageFilePath))).toBe(0);
			});
		});
	});
});
