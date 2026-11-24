import { describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Api } from '../../fixtures/environment';
import { createStorageTest } from '../../fixtures/storage';
import request, { setupRequest } from '../../fixtures/request';
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

const partialReads = [
	{ name: 'bounded', header: 'bytes=1-4', start: 1, end: 4 },
	{ name: 'open', header: 'bytes=7130-', start: 7130, end: 7135 },
	{ name: 'suffix', header: 'bytes=-6', start: 7130, end: 7135 },
];

async function uploadImage(api: Api, storage: string): Promise<string> {
	const response = await setupRequest(api.url)
		.post('/files')
		.set('Authorization', `Bearer ${api.adminToken}`)
		.field('storage', storage)
		.attach('file', createReadStream(imageFilePath));

	expect(response.body.data.storage).toBe(storage);

	return response.body.data.id;
}

describe('/assets', () => {
	describe('GET /assets/:id', () => {
		describe.each(storages)('Storage: %s', (storage) => {
			test('REST', async ({ api }) => {
				const id = await uploadImage(api, storage);

				const response = await request(api.url).get(`/assets/${id}`).set('Authorization', `Bearer ${api.adminToken}`);

				expect(response.statusCode).toBe(200);
				expect(response.headers['content-type']).toBe(imageFile.type);
				expect(response.headers['content-length']).toBe(imageFile.filesize);
				expect(Buffer.compare(response.body, await readFileSync(imageFilePath))).toBe(0);
			});

			for (const { name, header, start, end } of partialReads) {
				test(`REST ${name} range`, async ({ api }) => {
					const id = await uploadImage(api, storage);

					const response = await request(api.url)
						.get(`/assets/${id}`)
						.set('Authorization', `Bearer ${api.adminToken}`)
						.set('Range', header);

					expect(response.statusCode).toBe(206);
					expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${imageFile.filesize}`);
					expect(response.headers['content-length']).toBe(String(end - start + 1));
					expect(Buffer.compare(response.body, readFileSync(imageFilePath).subarray(start, end + 1))).toBe(0);
				});
			}
		});
	});
});
