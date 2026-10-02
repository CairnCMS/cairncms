import { setupRequest } from '../../fixtures/request';
import { afterEach, describe, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Api } from '../../fixtures/environment';
import * as common from '../../common/functions';
import { describeForVendors } from '../../fixtures/applicability';
import { createImportTest, type ImportFixture } from './import-fixture';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

const assetsDirectory = [fileURLToPath(new URL('../../../blackbox/assets/', import.meta.url))];
const imageFilePath = path.join(...assetsDirectory, 'directus.png');
const test = createImportTest(path.join(...assetsDirectory, 'layers.png'));

describe('/files upload limits and permission gate', () => {
	describeForVendors(
		'URL replacement permission gate',
		['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
		'This configured file API scenario has not been validated on SQLite.',
		() => {
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

			const rowFields = 'id,filename_disk,filesize,type,storage,folder,filename_download,title';

			async function readRow(api: Api, id: string) {
				const response = await request(api.url)
					.get(`/files/${id}`)
					.query({ fields: rowFields })
					.set('Authorization', `Bearer ${api.adminToken}`);

				expect(response.statusCode).toBe(200);
				return response;
			}

			const importReplace = (api: Api, imports: ImportFixture, token: string, url: string, id: string) =>
				request(imports.url).post('/files/import').set('Authorization', `Bearer ${token}`).send({ url, data: { id } });

			async function seedFile(api: Api, title: string, storage = 'local') {
				const response = await setupRequest(api.url)
					.post('/files')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.field('storage', storage)
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
				options: {
					name: string;
					token: string;
					email: string;
					fields: string[];
					conditional?: boolean;
					validation?: Record<string, unknown>;
				}
			) {
				const role = await common.CreateRole(api, {
					name: options.name,
					appAccessEnabled: false,
					adminAccessEnabled: false,
				});

				cleanups.push({ resource: `/roles/${role.id}`, run: () => deleteAsAdmin(api, `/roles/${role.id}`) });

				const filter = options.conditional ? { uploaded_by: { _eq: '$CURRENT_USER' } } : {};
				const validation = options.validation ?? {};

				const permission = await setupRequest(api.url)
					.post('/permissions')
					.set('Authorization', `Bearer ${api.adminToken}`)
					.send({
						role: role.id,
						collection: 'directus_files',
						action: 'update',
						fields: options.fields,
						permissions: filter,
						validation,
					});

				expect(permission.statusCode).toBe(200);
				expect(permission.body.data.fields).toEqual(options.fields);
				expect(permission.body.data.permissions).toEqual(filter);
				expect(permission.body.data.validation).toEqual(validation);

				const user = await common.CreateUser(api, { token: options.token, email: options.email, role: role.id });
				cleanups.push({ resource: `/users/${user.id}`, run: () => deleteAsAdmin(api, `/users/${user.id}`) });
				return options.token;
			}

			test('replaces a file from a URL for an update-only grant and fetches exactly once', async ({ api, imports }) => {
				const replacementBytes = readFileSync(layersFilePath);
				const fileId = await seedFile(api, 'url-replace-seed');

				const token = await createReplacer(api, {
					name: 'files-url-replace',
					token: 'FilesUrlReplaceToken',
					email: 'files-url-replace@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const before = imports.fixtureRequests;

				const replace = await request(imports.url)
					.post('/files/import')
					.set('Authorization', `Bearer ${token}`)
					.send({ url: `${imports.fixtureOrigin}/image.png`, data: { id: fileId } });

				// Without read permission, a successful replacement returns no body.
				expect(replace.statusCode).toBe(204);
				expect(imports.fixtureRequests - before).toBe(1);

				const asset = await readAsset(api, fileId);
				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, replacementBytes)).toBe(0);

				const readback = await readRow(api, fileId);
				expect(readback.statusCode).toBe(200);
				expect(readback.body.data.title).toBe('url-replace-seed');
				// Postgres returns bigint file sizes as strings.
				expect(Number(readback.body.data.filesize)).toBe(replacementBytes.length);
			});

			test('preserves a non-default storage location across a URL replace', async ({ api, imports }) => {
				const replacementBytes = readFileSync(layersFilePath);
				const fileId = await seedFile(api, 'url-replace-s3', 's3');

				const token = await createReplacer(api, {
					name: 'files-url-replace-s3',
					token: 'FilesUrlReplaceS3Token',
					email: 'files-url-replace-s3@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/image.png`, fileId);
				expect(replace.statusCode).toBe(204);

				const readback = await readRow(api, fileId);
				expect(readback.statusCode).toBe(200);
				expect(readback.body.data.storage).toBe('s3');

				const asset = await readAsset(api, fileId);
				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, replacementBytes)).toBe(0);
			});

			test('denies a URL replace whose grant omits a replace field without fetching or changing the row', async ({
				api,
				imports,
			}) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-field-denied');

				const token = await createReplacer(api, {
					name: 'files-url-title-only',
					token: 'FilesUrlTitleOnlyToken',
					email: 'files-url-title-only@example.com',
					fields: ['title'],
				});

				const rowBefore = await readRow(api, fileId);
				const before = imports.fixtureRequests;

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/image.png`, fileId);

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');
				expect(imports.fixtureRequests - before).toBe(0);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});

			test('denies a conditional grant from URL-replacing a foreign file without fetching or changing the row', async ({
				api,
				imports,
			}) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-foreign');

				const token = await createReplacer(api, {
					name: 'files-url-foreign',
					token: 'FilesUrlForeignToken',
					email: 'files-url-foreign@example.com',
					fields: ['*'],
					conditional: true,
				});

				const rowBefore = await readRow(api, fileId);
				const before = imports.fixtureRequests;

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/image.png`, fileId);

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');
				expect(imports.fixtureRequests - before).toBe(0);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});

			test('denies a URL replace of a missing file the same as an inaccessible one without fetching', async ({
				api,
				imports,
			}) => {
				const missingId = '00000000-0000-4000-8000-000000000000';

				const token = await createReplacer(api, {
					name: 'files-url-missing',
					token: 'FilesUrlMissingToken',
					email: 'files-url-missing@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
					conditional: true,
				});

				const before = imports.fixtureRequests;

				const replace = await request(imports.url)
					.post('/files/import')
					.set('Authorization', `Bearer ${token}`)
					.send({ url: `${imports.fixtureOrigin}/image.png`, data: { id: missingId } });

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');
				expect(imports.fixtureRequests - before).toBe(0);
			});

			test('rejects a URL replace whose fetched content type is not allowed and leaves the bytes intact', async ({
				api,
				imports,
			}) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-mime');

				const token = await createReplacer(api, {
					name: 'files-url-mime',
					token: 'FilesUrlMimeToken',
					email: 'files-url-mime@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(api, fileId);
				const before = imports.fixtureRequests;

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/note.txt`, fileId);

				expect(replace.statusCode).toBe(400);
				expect(imports.fixtureRequests - before).toBe(1);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});

			test('rejects an over-size URL replace and leaves the original file intact', async ({ api, imports }) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-oversize');

				const token = await createReplacer(api, {
					name: 'files-url-oversize',
					token: 'FilesUrlOversizeToken',
					email: 'files-url-oversize@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(api, fileId);

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/big.png`, fileId);
				expect(replace.statusCode).toBe(413);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});

			test('blocks a URL replace that redirects to a denied destination and leaves the file intact', async ({
				api,
				imports,
			}) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-redirect');

				const token = await createReplacer(api, {
					name: 'files-url-redirect',
					token: 'FilesUrlRedirectToken',
					email: 'files-url-redirect@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(api, fileId);
				const before = imports.fixtureRequests;
				const deniedBefore = imports.deniedRequests;

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/redirect`, fileId);
				expect(replace.statusCode).toBe(503);

				expect(imports.fixtureRequests - before).toBe(1);
				expect(imports.deniedRequests - deniedBefore).toBe(0);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});

			test('leaves the original file intact when the download is interrupted', async ({ api, imports }) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-interrupted');

				const token = await createReplacer(api, {
					name: 'files-url-interrupted',
					token: 'FilesUrlInterruptedToken',
					email: 'files-url-interrupted@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(api, fileId);

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/truncate`, fileId);
				expect(replace.statusCode).toBeGreaterThanOrEqual(500);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});

			test('rejects a URL replace on a post-fetch value rule and leaves the bytes intact', async ({ api, imports }) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(api, 'url-value-rule');

				const token = await createReplacer(api, {
					name: 'files-url-value-rule',
					token: 'FilesUrlValueRuleToken',
					email: 'files-url-value-rule@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
					validation: { type: { _eq: 'image/jpeg' } },
				});

				const rowBefore = await readRow(api, fileId);
				const before = imports.fixtureRequests;

				const replace = await importReplace(api, imports, token, `${imports.fixtureOrigin}/image.png`, fileId);

				expect(replace.statusCode).toBe(400);
				expect(replace.body.errors[0].extensions.code).toBe('FAILED_VALIDATION');
				expect(imports.fixtureRequests - before).toBe(1);

				const rowAfter = await readRow(api, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(api, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			});
		}
	);
});
