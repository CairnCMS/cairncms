import { setupRequest } from '../../fixtures/request';
import { afterEach, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { createApiTest, type Api } from '../../fixtures/environment';
import * as common from '../../common/functions';

import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const assetsDirectory = [fileURLToPath(new URL('../../fixtures/assets/', import.meta.url))];
const imageFilePath = path.join(...assetsDirectory, 'directus.png');
const test = createApiTest();

describe('/files upload limits and permission gate', () => {
	describe('PATCH /files/:pk permission gate', () => {
		const layersFilePath = path.join(...assetsDirectory, 'layers.png');
		const cleanups: Array<{ resource: string; run: () => PromiseLike<unknown> }> = [];

		const cleanupOrder = (resource: string) => {
			if (resource.startsWith('/files/')) return 0;
			if (resource.startsWith('/users/')) return 1;
			return 2;
		};

		afterEach(async () => {
			const failures: unknown[] = [];

			for (const cleanup of cleanups.splice(0).sort((a, b) => cleanupOrder(a.resource) - cleanupOrder(b.resource))) {
				try {
					const response = (await cleanup.run()) as { statusCode?: number };
					if (response?.statusCode && response.statusCode >= 400)
						throw new Error('File fixture cleanup ' + cleanup.resource + ' returned ' + response.statusCode);
				} catch (error) {
					failures.push(error);
				}
			}

			if (failures.length)
				throw new AggregateError(failures, 'File fixture cleanup failures: ' + failures.map(String).join('; '));
		});

		const deleteAsAdmin = (api: Api, resource: string) =>
			request(api.url).delete(resource).set('Authorization', `Bearer ${api.adminToken}`);

		const readAsset = (api: Api, id: string) =>
			request(api.url).get(`/assets/${id}`).set('Authorization', `Bearer ${api.adminToken}`);

		const rowFields = 'filename_disk,filesize,type,storage,folder,filename_download,title';

		const readRow = (api: Api, id: string) =>
			request(api.url)
				.get(`/files/${id}`)
				.query({ fields: rowFields })
				.set('Authorization', `Bearer ${api.adminToken}`);

		async function seedFile(api: Api, title: string) {
			const response = await setupRequest(api.url)
				.post('/files')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.field('storage', 'local')
				.field('title', title)
				.attach('file', createReadStream(imageFilePath));

			const id = response.body?.data?.id as string | undefined;
			if (id) cleanups.push({ resource: `/files/${id}`, run: () => deleteAsAdmin(api, `/files/${id}`) });

			expect(response.statusCode).toBe(200);
			expect(id).toBeDefined();
			return id as string;
		}

		async function createReplacer(
			api: Api,
			options: { name: string; token: string; email: string; fields: string[]; conditional?: boolean }
		) {
			const role = await common.CreateRole(api, {
				name: options.name,
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			cleanups.push({ resource: `/roles/${role.id}`, run: () => deleteAsAdmin(api, `/roles/${role.id}`) });

			const filter = options.conditional ? { uploaded_by: { _eq: '$CURRENT_USER' } } : {};

			const permission = await setupRequest(api.url)
				.post('/permissions')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({
					role: role.id,
					collection: 'directus_files',
					action: 'update',
					fields: options.fields,
					permissions: filter,
				});

			expect(permission.statusCode).toBe(200);
			expect(permission.body.data.fields).toEqual(options.fields);
			expect(permission.body.data.permissions).toEqual(filter);

			const user = await common.CreateUser(api, { token: options.token, email: options.email, role: role.id });
			cleanups.push({ resource: `/users/${user.id}`, run: () => deleteAsAdmin(api, `/users/${user.id}`) });
			return options.token;
		}

		test('denies a replace to a user without update access and leaves the original bytes intact', async ({ api }) => {
			const originalBytes = readFileSync(imageFilePath);

			const original = await request(api.url)
				.post('/files')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.field('storage', 'local')
				.attach('file', createReadStream(imageFilePath));

			expect(original.statusCode).toBe(200);

			const fileId = original.body.data.id;

			const role = await common.CreateRole(api, {
				name: 'files-viewer-no-update',
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			await request(api.url)
				.post('/permissions')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({ role: role.id, collection: 'directus_files', action: 'read' });

			await common.CreateUser(api, {
				token: 'FilesViewerToken',
				email: 'files-viewer@example.com',
				role: role.id,
			});

			// A distinct replacement so a regression that writes bytes before the 403 would be caught.
			const replace = await request(api.url)
				.patch(`/files/${fileId}`)
				.set('Authorization', `Bearer FilesViewerToken`)
				.field('storage', 'local')
				.attach('file', Buffer.from('replacement-not-the-original'), {
					filename: 'replacement.png',
					contentType: 'image/png',
				});

			expect(replace.statusCode).toBe(403);

			const asset = await request(api.url).get(`/assets/${fileId}`).set('Authorization', `Bearer ${api.adminToken}`);

			expect(asset.statusCode).toBe(200);
			expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
		});

		test('replaces the binary and preserves metadata for a grant covering the replace fields', async ({ api }) => {
			const replacementBytes = readFileSync(layersFilePath);
			const fileId = await seedFile(api, 'seed-title');

			const token = await createReplacer(api, {
				name: 'files-replace-fields',
				token: 'FilesReplaceFieldsToken',
				email: 'files-replace-fields@example.com',
				fields: ['folder', 'filename_download', 'storage', 'type'],
			});

			const replace = await request(api.url)
				.patch(`/files/${fileId}`)
				.set('Authorization', `Bearer ${token}`)
				.attach('file', createReadStream(layersFilePath));

			expect(replace.statusCode).toBe(204);

			const asset = await readAsset(api, fileId);
			expect(asset.statusCode).toBe(200);
			expect(Buffer.compare(asset.body, replacementBytes)).toBe(0);

			const readback = await request(api.url)
				.get(`/files/${fileId}`)
				.query({ fields: 'title' })
				.set('Authorization', `Bearer ${api.adminToken}`);

			expect(readback.statusCode).toBe(200);
			expect(readback.body.data.title).toBe('seed-title');
		});

		test('forbids a replace whose grant omits the replace fields and leaves the row and bytes intact', async ({
			api,
		}) => {
			const originalBytes = readFileSync(imageFilePath);
			const fileId = await seedFile(api, 'title-only-seed');

			const token = await createReplacer(api, {
				name: 'files-replace-title-only',
				token: 'FilesReplaceTitleOnlyToken',
				email: 'files-replace-title-only@example.com',
				fields: ['title'],
			});

			const before = await readRow(api, fileId);
			expect(before.statusCode).toBe(200);

			// Keep the socket open so an early denial can arrive while the file is still uploading.
			const replace = await request(api.url)
				.patch(`/files/${fileId}`)
				.set('Connection', 'keep-alive')
				.set('Authorization', `Bearer ${token}`)
				.attach('file', createReadStream(layersFilePath));

			expect(replace.statusCode).toBe(403);
			expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');

			const after = await readRow(api, fileId);
			expect(after.statusCode).toBe(200);
			expect(after.body.data).toEqual(before.body.data);

			const asset = await readAsset(api, fileId);
			expect(asset.statusCode).toBe(200);
			expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
		});

		test('forbids a conditional grant from replacing a foreign file and leaves the row and bytes intact', async ({
			api,
		}) => {
			const originalBytes = readFileSync(imageFilePath);
			const fileId = await seedFile(api, 'foreign-seed');

			const token = await createReplacer(api, {
				name: 'files-replace-foreign',
				token: 'FilesReplaceForeignToken',
				email: 'files-replace-foreign@example.com',
				fields: ['*'],
				conditional: true,
			});

			const before = await readRow(api, fileId);
			expect(before.statusCode).toBe(200);

			const replace = await request(api.url)
				.patch(`/files/${fileId}`)
				.set('Connection', 'keep-alive')
				.set('Authorization', `Bearer ${token}`)
				.attach('file', createReadStream(layersFilePath));

			expect(replace.statusCode).toBe(403);
			expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');

			const after = await readRow(api, fileId);
			expect(after.statusCode).toBe(200);
			expect(after.body.data).toEqual(before.body.data);

			const asset = await readAsset(api, fileId);
			expect(asset.statusCode).toBe(200);
			expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
		});
	});
});
