import { describe, expect } from 'vitest';
import { identityTest as test } from '../../fixtures/identities';
import * as common from '../../fixtures/identities';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

describe('/files', () => {
	describe('POST /', () => {
		describe('when only request body is provided without any multipart files', () => {
			describe('returns created file when required properties are included', () => {
				test('REST', async ({ api }) => {
					// Setup
					const payload = {
						title: 'Test File',
						storage: 'local',
						filename_download: 'test_file',
						type: 'application/octet-stream',
					};

					// Action
					const response = await request(api.url)
						.post(`/files`)
						.send(payload)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toBe(200);

					expect(response.body).toMatchObject({
						data: {
							title: payload.title,
							storage: payload.storage,
							filename_download: payload.filename_download,
						},
					});
				});
			});

			describe('returns code: FAILED_VALIDATION when required property "storage" is not included', () => {
				test('REST', async ({ api }) => {
					// Setup
					const payload = { title: 'Test File', filename_download: 'test_file', type: 'application/octet-stream' };

					// Action
					const response = await request(api.url)
						.post(`/files`)
						.send(payload)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toBe(400);

					expect(response.body).toMatchObject({
						errors: [
							{
								message: '"storage" is required',
								extensions: {
									code: 'FAILED_VALIDATION',
								},
							},
						],
					});
				});
			});
		});
	});
});
