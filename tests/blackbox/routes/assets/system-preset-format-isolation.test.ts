import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { createReadStream } from 'fs';
import path from 'path';
import request from 'supertest';

jest.setTimeout(30000);

const assetsDirectory = [__dirname, '..', '..', 'assets'];
const storages = ['local', 'minio'];

const imageFile = {
	name: 'directus.png',
	type: 'image/png',
};

const imageFilePath = path.join(...assetsDirectory, imageFile.name);

describe('/assets system-preset format negotiation isolation', () => {
	describe('Two sequential requests for the same system preset with different Accept headers get independent format negotiation', () => {
		describe.each(storages)('Storage: %s', (storage) => {
			it.each(vendors)('%s', async (vendor) => {
				const insertResponse = await request(getUrl(vendor))
					.post('/files')
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.field('storage', storage)
					.attach('file', createReadStream(imageFilePath));

				const fileId = insertResponse.body.data.id;

				const webpResponse = await request(getUrl(vendor))
					.get(`/assets/${fileId}?key=system-medium-contain`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.set('Accept', 'image/webp');

				expect(webpResponse.statusCode).toBe(200);
				expect(webpResponse.headers['content-type']).toBe('image/webp');

				const avifResponse = await request(getUrl(vendor))
					.get(`/assets/${fileId}?key=system-medium-contain`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.set('Accept', 'image/avif');

				expect(avifResponse.statusCode).toBe(200);
				expect(avifResponse.headers['content-type']).toBe('image/avif');

				const ping = await request(getUrl(vendor)).get('/server/ping');

				expect(ping.statusCode).toBe(200);
				expect(ping.text).toBe('pong');
			});
		});
	});
});
