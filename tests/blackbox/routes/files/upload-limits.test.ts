import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { createReadStream, readFileSync } from 'fs';
import { cloneDeep } from 'lodash';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'path';
import request from 'supertest';

const assetsDirectory = [__dirname, '..', '..', 'assets'];
const imageFilePath = path.join(...assetsDirectory, 'directus.png');
const adminToken = common.USER.ADMIN.TOKEN;

// A separate loopback IP lets the redirect target be blocked independently.
const DENIED_HOST = '127.0.0.2';

function createFixtureServer(imageBytes: Buffer, onRequest: () => void, redirectTarget: string) {
	return http.createServer((req, res) => {
		onRequest();

		if (req.url === '/note.txt') {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('plain text, not an image');
			return;
		}

		if (req.url === '/big.png') {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(Buffer.alloc(2 * 1024 * 1024, 0x61));
			return;
		}

		if (req.url === '/redirect') {
			res.writeHead(302, { location: redirectTarget });
			res.end();
			return;
		}

		if (req.url === '/truncate') {
			res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024) });
			// Abort after sending data so the failure occurs during the download.
			res.write(Buffer.alloc(1024, 0x61), () => res.destroy());
			return;
		}

		res.writeHead(200, { 'content-type': 'image/png' });
		res.end(imageBytes);
	});
}

function createCountingServer(imageBytes: Buffer, onRequest: () => void) {
	return http.createServer((req, res) => {
		onRequest();
		res.writeHead(200, { 'content-type': 'image/png' });
		res.end(imageBytes);
	});
}

describe('/files upload limits and permission gate', () => {
	describe('PATCH /files/:pk permission gate', () => {
		const layersFilePath = path.join(...assetsDirectory, 'layers.png');
		const cleanups: Array<() => Promise<unknown>> = [];

		afterAll(async () => {
			for (const cleanup of cleanups.reverse()) {
				await cleanup().catch(() => undefined);
			}
		});

		const deleteAsAdmin = (vendor: string, resource: string) =>
			request(getUrl(vendor)).delete(resource).set('Authorization', `Bearer ${adminToken}`);

		const readAsset = (vendor: string, id: string) =>
			request(getUrl(vendor)).get(`/assets/${id}`).set('Authorization', `Bearer ${adminToken}`);

		const rowFields = 'filename_disk,filesize,type,storage,folder,filename_download,title';

		const readRow = (vendor: string, id: string) =>
			request(getUrl(vendor))
				.get(`/files/${id}`)
				.query({ fields: rowFields })
				.set('Authorization', `Bearer ${adminToken}`);

		async function seedFile(vendor: string, title: string) {
			const response = await request(getUrl(vendor))
				.post('/files')
				.set('Authorization', `Bearer ${adminToken}`)
				.field('storage', 'local')
				.field('title', title)
				.attach('file', createReadStream(imageFilePath));

			const id = response.body?.data?.id as string | undefined;
			if (id) cleanups.push(() => deleteAsAdmin(vendor, `/files/${id}`));

			expect(response.statusCode).toBe(200);
			expect(id).toBeDefined();
			return id as string;
		}

		async function createReplacer(
			vendor: string,
			options: { name: string; token: string; email: string; fields: string[]; conditional?: boolean }
		) {
			const role = await common.CreateRole(vendor, {
				name: options.name,
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			cleanups.push(() => deleteAsAdmin(vendor, `/roles/${role.id}`));

			const filter = options.conditional ? { uploaded_by: { _eq: '$CURRENT_USER' } } : {};

			const permission = await request(getUrl(vendor))
				.post('/permissions')
				.set('Authorization', `Bearer ${adminToken}`)
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

			const user = await common.CreateUser(vendor, { token: options.token, email: options.email, role: role.id });
			cleanups.push(() => deleteAsAdmin(vendor, `/users/${user.id}`));
			return options.token;
		}

		it.each(vendors)(
			'%s denies a replace to a user without update access and leaves the original bytes intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);

				const original = await request(getUrl(vendor))
					.post('/files')
					.set('Authorization', `Bearer ${adminToken}`)
					.field('storage', 'local')
					.attach('file', createReadStream(imageFilePath));

				expect(original.statusCode).toBe(200);

				const fileId = original.body.data.id;

				const role = await common.CreateRole(vendor, {
					name: 'files-viewer-no-update',
					appAccessEnabled: false,
					adminAccessEnabled: false,
				});

				await request(getUrl(vendor))
					.post('/permissions')
					.set('Authorization', `Bearer ${adminToken}`)
					.send({ role: role.id, collection: 'directus_files', action: 'read' });

				await common.CreateUser(vendor, {
					token: 'FilesViewerToken',
					email: 'files-viewer@example.com',
					role: role.id,
				});

				// A distinct replacement so a regression that writes bytes before the 403 would be caught.
				const replace = await request(getUrl(vendor))
					.patch(`/files/${fileId}`)
					.set('Authorization', `Bearer FilesViewerToken`)
					.field('storage', 'local')
					.attach('file', Buffer.from('replacement-not-the-original'), {
						filename: 'replacement.png',
						contentType: 'image/png',
					});

				expect(replace.statusCode).toBe(403);

				const asset = await request(getUrl(vendor))
					.get(`/assets/${fileId}`)
					.set('Authorization', `Bearer ${adminToken}`);

				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(vendors)(
			'%s replaces the binary and preserves metadata for a grant covering the replace fields',
			async (vendor) => {
				const replacementBytes = readFileSync(layersFilePath);
				const fileId = await seedFile(vendor, 'seed-title');

				const token = await createReplacer(vendor, {
					name: 'files-replace-fields',
					token: 'FilesReplaceFieldsToken',
					email: 'files-replace-fields@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const replace = await request(getUrl(vendor))
					.patch(`/files/${fileId}`)
					.set('Authorization', `Bearer ${token}`)
					.attach('file', createReadStream(layersFilePath));

				expect(replace.statusCode).toBe(204);

				const asset = await readAsset(vendor, fileId);
				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, replacementBytes)).toBe(0);

				const readback = await request(getUrl(vendor))
					.get(`/files/${fileId}`)
					.query({ fields: 'title' })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(readback.statusCode).toBe(200);
				expect(readback.body.data.title).toBe('seed-title');
			}
		);

		it.each(vendors)(
			'%s forbids a replace whose grant omits the replace fields and leaves the row and bytes intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'title-only-seed');

				const token = await createReplacer(vendor, {
					name: 'files-replace-title-only',
					token: 'FilesReplaceTitleOnlyToken',
					email: 'files-replace-title-only@example.com',
					fields: ['title'],
				});

				const before = await readRow(vendor, fileId);
				expect(before.statusCode).toBe(200);

				const replace = await request(getUrl(vendor))
					.patch(`/files/${fileId}`)
					.set('Authorization', `Bearer ${token}`)
					.attach('file', createReadStream(layersFilePath));

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');

				const after = await readRow(vendor, fileId);
				expect(after.statusCode).toBe(200);
				expect(after.body.data).toEqual(before.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(vendors)(
			'%s forbids a conditional grant from replacing a foreign file and leaves the row and bytes intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'foreign-seed');

				const token = await createReplacer(vendor, {
					name: 'files-replace-foreign',
					token: 'FilesReplaceForeignToken',
					email: 'files-replace-foreign@example.com',
					fields: ['*'],
					conditional: true,
				});

				const before = await readRow(vendor, fileId);
				expect(before.statusCode).toBe(200);

				const replace = await request(getUrl(vendor))
					.patch(`/files/${fileId}`)
					.set('Authorization', `Bearer ${token}`)
					.attach('file', createReadStream(layersFilePath));

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');

				const after = await readRow(vendor, fileId);
				expect(after.statusCode).toBe(200);
				expect(after.body.data).toEqual(before.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);
	});

	// SQLite cannot safely share a single file across instances, and this block spawns a
	// dedicated limit-configured instance alongside the default one.
	const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
	const describeLimits = supportedVendors.length > 0 ? describe : describe.skip;

	describeLimits('size and MIME allow-list enforcement', () => {
		const instances = {} as { [vendor: string]: ChildProcess };
		const envs = {} as { [vendor: string]: Env };

		beforeAll(async () => {
			const promises = [];

			for (const vendor of supportedVendors) {
				const env = cloneDeep(config.envs);
				env[vendor].FILES_MAX_UPLOAD_SIZE = '1mb';
				env[vendor].FILES_MIME_TYPE_ALLOW_LIST = 'image/png';

				const port = Number(env[vendor]!.PORT) + 350;
				env[vendor]!.PORT = String(port);

				instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
					cwd: paths.cwd,
					env: env[vendor],
				});

				envs[vendor] = env;
				promises.push(awaitDirectusConnection(port));
			}

			await Promise.all(promises);
		}, 300000);

		afterAll(() => {
			for (const vendor of supportedVendors) {
				instances[vendor]!.kill();
			}
		});

		it.each(supportedVendors)('%s rejects an oversized upload with 413 and leaves no orphan row', async (vendor) => {
			const env = envs[vendor]!;

			const oversized = await request(getUrl(vendor, env))
				.post('/files')
				.set('Authorization', `Bearer ${adminToken}`)
				.field('storage', 'local')
				.field('title', 'oversized-orphan-probe')
				.attach('file', Buffer.alloc(2 * 1024 * 1024), { filename: 'big.png', contentType: 'image/png' });

			expect(oversized.statusCode).toBe(413);

			const orphans = await request(getUrl(vendor, env))
				.get('/files')
				.query({ 'filter[title][_eq]': 'oversized-orphan-probe' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(orphans.body.data).toHaveLength(0);
		});

		it.each(supportedVendors)('%s accepts an allowed content type within the cap', async (vendor) => {
			const env = envs[vendor]!;

			const response = await request(getUrl(vendor, env))
				.post('/files')
				.set('Authorization', `Bearer ${adminToken}`)
				.field('storage', 'local')
				.attach('file', createReadStream(imageFilePath));

			expect(response.statusCode).toBe(200);
			expect(response.body.data.type).toBe('image/png');
		});

		it.each(supportedVendors)('%s rejects a disallowed content type with 400', async (vendor) => {
			const env = envs[vendor]!;

			const response = await request(getUrl(vendor, env))
				.post('/files')
				.set('Authorization', `Bearer ${adminToken}`)
				.field('storage', 'local')
				.attach('file', Buffer.from('plain text, not an image'), { filename: 'note.txt', contentType: 'text/plain' });

			expect(response.statusCode).toBe(400);
		});
	});

	describeLimits('URL replacement permission gate', () => {
		const layersFilePath = path.join(...assetsDirectory, 'layers.png');
		const instances = {} as { [vendor: string]: ChildProcess };
		const envs = {} as { [vendor: string]: Env };
		const cleanups: Array<() => Promise<unknown>> = [];

		let fixture: http.Server;
		let fixtureOrigin: string;
		let fixtureRequests = 0;

		let deniedFixture: http.Server;
		let deniedRequests = 0;

		const deleteAsAdmin = (vendor: string, resource: string) =>
			request(getUrl(vendor)).delete(resource).set('Authorization', `Bearer ${adminToken}`);

		const readAsset = (vendor: string, id: string) =>
			request(getUrl(vendor)).get(`/assets/${id}`).set('Authorization', `Bearer ${adminToken}`);

		const rowFields = 'id,filename_disk,filesize,type,storage,folder,filename_download,title';

		async function readRow(vendor: string, id: string) {
			const response = await request(getUrl(vendor))
				.get(`/files/${id}`)
				.query({ fields: rowFields })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(response.statusCode).toBe(200);
			return response;
		}

		const importReplace = (vendor: string, token: string, url: string, id: string) =>
			request(getUrl(vendor, envs[vendor]!))
				.post('/files/import')
				.set('Authorization', `Bearer ${token}`)
				.send({ url, data: { id } });

		async function seedFile(vendor: string, title: string, storage = 'local') {
			const response = await request(getUrl(vendor))
				.post('/files')
				.set('Authorization', `Bearer ${adminToken}`)
				.field('storage', storage)
				.field('title', title)
				.attach('file', createReadStream(imageFilePath));

			const id = response.body?.data?.id as string | undefined;
			if (id) cleanups.push(() => deleteAsAdmin(vendor, `/files/${id}`));

			expect(response.statusCode).toBe(200);
			expect(id).toBeDefined();
			return id as string;
		}

		async function createReplacer(
			vendor: string,
			options: {
				name: string;
				token: string;
				email: string;
				fields: string[];
				conditional?: boolean;
				validation?: Record<string, unknown>;
			}
		) {
			const role = await common.CreateRole(vendor, {
				name: options.name,
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			cleanups.push(() => deleteAsAdmin(vendor, `/roles/${role.id}`));

			const filter = options.conditional ? { uploaded_by: { _eq: '$CURRENT_USER' } } : {};
			const validation = options.validation ?? {};

			const permission = await request(getUrl(vendor))
				.post('/permissions')
				.set('Authorization', `Bearer ${adminToken}`)
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

			const user = await common.CreateUser(vendor, { token: options.token, email: options.email, role: role.id });
			cleanups.push(() => deleteAsAdmin(vendor, `/users/${user.id}`));
			return options.token;
		}

		beforeAll(async () => {
			const imageBytes = readFileSync(layersFilePath);

			deniedFixture = createCountingServer(imageBytes, () => {
				deniedRequests += 1;
			});

			await new Promise<void>((resolve) => deniedFixture.listen(0, DENIED_HOST, () => resolve()));
			const deniedPort = (deniedFixture.address() as AddressInfo).port;
			const deniedOrigin = `http://${DENIED_HOST}:${deniedPort}`;

			fixture = createFixtureServer(
				imageBytes,
				() => {
					fixtureRequests += 1;
				},
				`${deniedOrigin}/blocked.png`
			);

			await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', () => resolve()));
			const address = fixture.address() as AddressInfo;
			fixtureOrigin = `http://127.0.0.1:${address.port}`;

			const promises = [];

			for (const vendor of supportedVendors) {
				const env = cloneDeep(config.envs);
				// Replace the default loopback block so only the redirect target is denied.
				env[vendor].IMPORT_IP_DENY_LIST = DENIED_HOST;
				env[vendor].FILES_MIME_TYPE_ALLOW_LIST = 'image/png';
				env[vendor].FILES_MAX_UPLOAD_SIZE = '1mb';

				const port = Number(env[vendor]!.PORT) + 360;
				env[vendor]!.PORT = String(port);

				instances[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
					cwd: paths.cwd,
					env: env[vendor],
				});

				envs[vendor] = env;
				promises.push(awaitDirectusConnection(port));
			}

			await Promise.all(promises);
		}, 300000);

		afterAll(async () => {
			for (const cleanup of cleanups.reverse()) {
				await cleanup().catch(() => undefined);
			}

			for (const vendor of supportedVendors) {
				instances[vendor]!.kill();
			}

			await new Promise<void>((resolve) => fixture.close(() => resolve()));
			await new Promise<void>((resolve) => deniedFixture.close(() => resolve()));
		});

		it.each(supportedVendors)(
			'%s replaces a file from a URL for an update-only grant and fetches exactly once',
			async (vendor) => {
				const env = envs[vendor]!;
				const replacementBytes = readFileSync(layersFilePath);
				const fileId = await seedFile(vendor, 'url-replace-seed');

				const token = await createReplacer(vendor, {
					name: 'files-url-replace',
					token: 'FilesUrlReplaceToken',
					email: 'files-url-replace@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const before = fixtureRequests;

				const replace = await request(getUrl(vendor, env))
					.post('/files/import')
					.set('Authorization', `Bearer ${token}`)
					.send({ url: `${fixtureOrigin}/image.png`, data: { id: fileId } });

				// Without read permission, a successful replacement returns no body.
				expect(replace.statusCode).toBe(204);
				expect(fixtureRequests - before).toBe(1);

				const asset = await readAsset(vendor, fileId);
				expect(asset.statusCode).toBe(200);
				expect(Buffer.compare(asset.body, replacementBytes)).toBe(0);

				const readback = await readRow(vendor, fileId);
				expect(readback.statusCode).toBe(200);
				expect(readback.body.data.title).toBe('url-replace-seed');
				// Postgres returns bigint file sizes as strings.
				expect(Number(readback.body.data.filesize)).toBe(replacementBytes.length);
			}
		);

		it.each(supportedVendors)('%s preserves a non-default storage location across a URL replace', async (vendor) => {
			const replacementBytes = readFileSync(layersFilePath);
			const fileId = await seedFile(vendor, 'url-replace-s3', 's3');

			const token = await createReplacer(vendor, {
				name: 'files-url-replace-s3',
				token: 'FilesUrlReplaceS3Token',
				email: 'files-url-replace-s3@example.com',
				fields: ['folder', 'filename_download', 'storage', 'type'],
			});

			const replace = await importReplace(vendor, token, `${fixtureOrigin}/image.png`, fileId);
			expect(replace.statusCode).toBe(204);

			const readback = await readRow(vendor, fileId);
			expect(readback.statusCode).toBe(200);
			expect(readback.body.data.storage).toBe('s3');

			const asset = await readAsset(vendor, fileId);
			expect(asset.statusCode).toBe(200);
			expect(Buffer.compare(asset.body, replacementBytes)).toBe(0);
		});

		it.each(supportedVendors)(
			'%s denies a URL replace whose grant omits a replace field without fetching or changing the row',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'url-field-denied');

				const token = await createReplacer(vendor, {
					name: 'files-url-title-only',
					token: 'FilesUrlTitleOnlyToken',
					email: 'files-url-title-only@example.com',
					fields: ['title'],
				});

				const rowBefore = await readRow(vendor, fileId);
				const before = fixtureRequests;

				const replace = await importReplace(vendor, token, `${fixtureOrigin}/image.png`, fileId);

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');
				expect(fixtureRequests - before).toBe(0);

				const rowAfter = await readRow(vendor, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(supportedVendors)(
			'%s denies a conditional grant from URL-replacing a foreign file without fetching or changing the row',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'url-foreign');

				const token = await createReplacer(vendor, {
					name: 'files-url-foreign',
					token: 'FilesUrlForeignToken',
					email: 'files-url-foreign@example.com',
					fields: ['*'],
					conditional: true,
				});

				const rowBefore = await readRow(vendor, fileId);
				const before = fixtureRequests;

				const replace = await importReplace(vendor, token, `${fixtureOrigin}/image.png`, fileId);

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');
				expect(fixtureRequests - before).toBe(0);

				const rowAfter = await readRow(vendor, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(supportedVendors)(
			'%s denies a URL replace of a missing file the same as an inaccessible one without fetching',
			async (vendor) => {
				const env = envs[vendor]!;
				const missingId = '00000000-0000-4000-8000-000000000000';

				const token = await createReplacer(vendor, {
					name: 'files-url-missing',
					token: 'FilesUrlMissingToken',
					email: 'files-url-missing@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
					conditional: true,
				});

				const before = fixtureRequests;

				const replace = await request(getUrl(vendor, env))
					.post('/files/import')
					.set('Authorization', `Bearer ${token}`)
					.send({ url: `${fixtureOrigin}/image.png`, data: { id: missingId } });

				expect(replace.statusCode).toBe(403);
				expect(replace.body.errors[0].extensions.code).toBe('FORBIDDEN');
				expect(fixtureRequests - before).toBe(0);
			}
		);

		it.each(supportedVendors)(
			'%s rejects a URL replace whose fetched content type is not allowed and leaves the bytes intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'url-mime');

				const token = await createReplacer(vendor, {
					name: 'files-url-mime',
					token: 'FilesUrlMimeToken',
					email: 'files-url-mime@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(vendor, fileId);
				const before = fixtureRequests;

				const replace = await importReplace(vendor, token, `${fixtureOrigin}/note.txt`, fileId);

				expect(replace.statusCode).toBe(400);
				expect(fixtureRequests - before).toBe(1);

				const rowAfter = await readRow(vendor, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(supportedVendors)(
			'%s rejects an over-size URL replace and leaves the original file intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'url-oversize');

				const token = await createReplacer(vendor, {
					name: 'files-url-oversize',
					token: 'FilesUrlOversizeToken',
					email: 'files-url-oversize@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(vendor, fileId);

				const replace = await importReplace(vendor, token, `${fixtureOrigin}/big.png`, fileId);
				expect(replace.statusCode).toBe(413);

				const rowAfter = await readRow(vendor, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(supportedVendors)(
			'%s blocks a URL replace that redirects to a denied destination and leaves the file intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'url-redirect');

				const token = await createReplacer(vendor, {
					name: 'files-url-redirect',
					token: 'FilesUrlRedirectToken',
					email: 'files-url-redirect@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
				});

				const rowBefore = await readRow(vendor, fileId);
				const before = fixtureRequests;
				const deniedBefore = deniedRequests;

				const replace = await importReplace(vendor, token, `${fixtureOrigin}/redirect`, fileId);
				expect(replace.statusCode).toBe(503);

				expect(fixtureRequests - before).toBe(1);
				expect(deniedRequests - deniedBefore).toBe(0);

				const rowAfter = await readRow(vendor, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);

		it.each(supportedVendors)('%s leaves the original file intact when the download is interrupted', async (vendor) => {
			const originalBytes = readFileSync(imageFilePath);
			const fileId = await seedFile(vendor, 'url-interrupted');

			const token = await createReplacer(vendor, {
				name: 'files-url-interrupted',
				token: 'FilesUrlInterruptedToken',
				email: 'files-url-interrupted@example.com',
				fields: ['folder', 'filename_download', 'storage', 'type'],
			});

			const rowBefore = await readRow(vendor, fileId);

			const replace = await importReplace(vendor, token, `${fixtureOrigin}/truncate`, fileId);
			expect(replace.statusCode).toBeGreaterThanOrEqual(500);

			const rowAfter = await readRow(vendor, fileId);
			expect(rowAfter.body.data).toEqual(rowBefore.body.data);

			const asset = await readAsset(vendor, fileId);
			expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
		});

		it.each(supportedVendors)(
			'%s rejects a URL replace on a post-fetch value rule and leaves the bytes intact',
			async (vendor) => {
				const originalBytes = readFileSync(imageFilePath);
				const fileId = await seedFile(vendor, 'url-value-rule');

				const token = await createReplacer(vendor, {
					name: 'files-url-value-rule',
					token: 'FilesUrlValueRuleToken',
					email: 'files-url-value-rule@example.com',
					fields: ['folder', 'filename_download', 'storage', 'type'],
					validation: { type: { _eq: 'image/jpeg' } },
				});

				const rowBefore = await readRow(vendor, fileId);
				const before = fixtureRequests;

				const replace = await importReplace(vendor, token, `${fixtureOrigin}/image.png`, fileId);

				expect(replace.statusCode).toBe(400);
				expect(replace.body.errors[0].extensions.code).toBe('FAILED_VALIDATION');
				expect(fixtureRequests - before).toBe(1);

				const rowAfter = await readRow(vendor, fileId);
				expect(rowAfter.body.data).toEqual(rowBefore.body.data);

				const asset = await readAsset(vendor, fileId);
				expect(Buffer.compare(asset.body, originalBytes)).toBe(0);
			}
		);
	});
});
