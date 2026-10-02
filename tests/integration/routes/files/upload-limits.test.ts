import { describe, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createApiTest } from '../../fixtures/environment';

import { describeForVendors } from '../../fixtures/applicability';

import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

const assetsDirectory = [fileURLToPath(new URL('../../fixtures/assets/', import.meta.url))];
const imageFilePath = path.join(...assetsDirectory, 'directus.png');
const test = createApiTest({ env: { FILES_MAX_UPLOAD_SIZE: '1mb', FILES_MIME_TYPE_ALLOW_LIST: 'image/png' } });

describe('/files upload limits and permission gate', () => {
	describeForVendors(
		'size and MIME allow-list enforcement',
		['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
		'This configured file API scenario has not been validated on SQLite.',
		() => {
			test('rejects an oversized upload with 413 and leaves no orphan row', async ({ api }) => {
				const oversized = await request(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', 'local')
					.field('title', 'oversized-orphan-probe')
					.attach('file', Buffer.alloc(2 * 1024 * 1024), { filename: 'big.png', contentType: 'image/png' });

				expect(oversized.statusCode).toBe(413);

				const orphans = await request(api.url)
					.get('/files')
					.query({ 'filter[title][_eq]': 'oversized-orphan-probe' })
					.set('Authorization', `Bearer ${api.adminToken}`);

				expect(orphans.body.data).toHaveLength(0);
			});

			test('accepts an allowed content type within the cap', async ({ api }) => {
				const response = await request(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', 'local')
					.attach('file', createReadStream(imageFilePath));

				expect(response.statusCode).toBe(200);
				expect(response.body.data.type).toBe('image/png');
			});

			test('rejects a disallowed content type with 400', async ({ api }) => {
				const response = await request(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', 'local')
					.attach('file', Buffer.from('plain text, not an image'), { filename: 'note.txt', contentType: 'text/plain' });

				expect(response.statusCode).toBe(400);
			});
		}
	);
});
