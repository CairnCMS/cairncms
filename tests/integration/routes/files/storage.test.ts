import { describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createStorageTest } from '../../fixtures/storage';
import request from '../../fixtures/request';
import { createReadStream } from 'fs';
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
	title: 'Directus',
	description: 'The Directus Logo',
};

const imageFilePath = path.join(...assetsDirectory, imageFile.name);

describe('/files', () => {
	describe('POST /files', () => {
		describe.each(storages)('Storage: %s', (storage) => {
			test('REST', async ({ api }) => {
				// Action
				const response = await request(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', storage)
					.field('title', imageFile.title)
					.field('description', imageFile.description)
					.attach('file', createReadStream(imageFilePath));

				// Normalize filesize to string as bigint returns as a string
				response.body.data.filesize = String(response.body.data.filesize);

				// Assert
				expect(response.statusCode).toBe(200);

				expect(response.body.data).toEqual(
					expect.objectContaining({
						filesize: imageFile.filesize,
						type: imageFile.type,
						filename_download: imageFile.name,
						filename_disk: expect.any(String),
						storage: storage,
						title: imageFile.title,
						description: imageFile.description,
						id: expect.any(String),
					})
				);
			});
		});
	});

	describe('DELETE /files/:id', () => {
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
					.delete(`/files/${insertResponse.body.data.id}`)
					.set('Authorization', `Bearer ${api.adminToken}`);

				// Assert
				expect(response.statusCode).toEqual(204);
				expect(response.body.data).toBe(undefined);
			});
		});
	});
});
