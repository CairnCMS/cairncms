import { expect } from 'vitest';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createStorageTest } from '../../fixtures/storage';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const test = createStorageTest();

for (const storage of ['local', 's3']) {
	test(`${storage} uploads, reads and removes real bytes`, async ({ api, storage: s3 }) => {
		const content = Buffer.from('independent storage fixture\n');

		const uploaded = await request(api.url)
			.post('/files')
			.auth(api.adminToken, { type: 'bearer' })
			.field('storage', storage)
			.attach('file', content, 'probe.txt')
			.expect(200);

		const file = uploaded.body.data;
		expect(file.storage).toBe(storage);
		expect(Number(file.filesize)).toBe(content.length);
		const asset = await request(api.url).get(`/assets/${file.id}`).auth(api.adminToken, { type: 'bearer' }).expect(200);
		expect(asset.text).toBe(content.toString());

		if (storage === 's3') {
			const object = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: file.filename_disk }), {
				abortSignal: AbortSignal.timeout(10_000),
			});

			expect(await object.Body!.transformToString()).toBe(content.toString());
		}

		await request(api.url).delete(`/files/${file.id}`).auth(api.adminToken, { type: 'bearer' }).expect(204);
		await request(api.url).get(`/assets/${file.id}`).auth(api.adminToken, { type: 'bearer' }).expect(403);

		if (storage === 's3')
			await expect(
				s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: file.filename_disk }), {
					abortSignal: AbortSignal.timeout(10_000),
				})
			).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
	});
}
