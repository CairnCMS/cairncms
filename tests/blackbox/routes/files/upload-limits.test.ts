import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { createReadStream, readFileSync } from 'fs';
import { cloneDeep } from 'lodash';
import path from 'path';
import request from 'supertest';

const assetsDirectory = [__dirname, '..', '..', 'assets'];
const imageFilePath = path.join(...assetsDirectory, 'directus.png');
const adminToken = common.USER.ADMIN.TOKEN;

describe('/files upload limits and permission gate', () => {
	describe('PATCH /files/:pk permission gate', () => {
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
});
