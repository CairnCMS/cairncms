import { identityTest as test, USER, TEST_USERS } from '../../fixtures/identities';
import { describe, expect } from 'vitest';
import request, { requestGraphQL } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

describe('/server', () => {
	describe('GET /health', () => {
		TEST_USERS.forEach((userKey) => {
			describe(USER[userKey]!.NAME, () => {
				test('REST and GraphQL', async ({ api }) => {
					// Action
					const response = await request(api.url)
						.get('/server/health')
						.set('Authorization', `Bearer ${USER[userKey]!.TOKEN}`);

					const gqlResponse = await requestGraphQL(api.url, true, USER[userKey]!.TOKEN, {
						query: {
							server_health: true,
						},
					});

					// Assert
					expect(response.statusCode).toBe(200);
					expect(gqlResponse.statusCode).toBe(200);

					if (userKey === 'ADMIN') {
						const adminResult = {
							status: 'ok',
							releaseId: expect.any(String),
							serviceId: expect.any(String),
							checks: expect.anything(),
						};

						expect(response.body).toEqual(adminResult);
						expect(gqlResponse.body.data.server_health).toEqual(adminResult);
					} else {
						const nonAdminResult = { status: 'ok' };

						expect(response.body).toEqual(nonAdminResult);
						expect(gqlResponse.body.data.server_health).toEqual(nonAdminResult);
					}
				});
			});
		});
	});
});
