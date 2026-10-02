import { identityTest as test, USER, TEST_USERS } from '../../fixtures/identities';
import { describe, expect } from 'vitest';
import request, { requestGraphQL } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

describe('/server', () => {
	describe('GET /info', () => {
		describe('REST', () => {
			describe('Unauthenticated', () => {
				test('returns the authorized response', async ({ api }) => {
					// Action
					const response = await request(api.url).get('/server/info');

					// Assert
					expect(response.statusCode).toBe(200);
					expect(response.body.data).not.toHaveProperty('cairncms');
					expect(response.body.data).not.toHaveProperty('node');
					expect(response.body.data).not.toHaveProperty('os');
				});
			});

			TEST_USERS.forEach((userKey) => {
				describe(USER[userKey]!.NAME, () => {
					test('returns the authorized response', async ({ api }) => {
						// Action
						const response = await request(api.url)
							.get('/server/info')
							.set('Authorization', `Bearer ${USER[userKey]!.TOKEN}`);

						// Assert
						expect(response.statusCode).toBe(200);
						expect(response.body.data).not.toHaveProperty('node');
						expect(response.body.data).not.toHaveProperty('os');
						expect(response.headers['cache-control']).toMatch(/no-cache|no-store/);

						if (userKey === 'ADMIN') {
							expect(response.body.data.cairncms).toEqual({ version: expect.any(String) });
						} else {
							expect(response.body.data).not.toHaveProperty('cairncms');
						}
					});
				});
			});
		});

		describe('GraphQL', () => {
			describe('admin reads cairncms.version', () => {
				test('returns the authorized response', async ({ api }) => {
					// Action
					const gqlResponse = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
						query: {
							server_info: {
								cairncms: {
									version: true,
								},
							},
						},
					});

					// Assert
					expect(gqlResponse.statusCode).toBe(200);
					expect(gqlResponse.body.data.server_info.cairncms.version).toEqual(expect.any(String));
				});
			});

			describe('node and os are absent from the server_info schema', () => {
				test('returns the authorized response', async ({ api }) => {
					// Action
					const nodeResponse = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
						query: {
							server_info: {
								node: {
									version: true,
								},
							},
						},
					});

					const osResponse = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
						query: {
							server_info: {
								os: {
									type: true,
								},
							},
						},
					});

					// Assert
					expect(nodeResponse.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_EXCEPTION');
					expect(osResponse.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_EXCEPTION');
				});
			});

			describe('cairncms is absent from the server_info schema for non-admins', () => {
				test('non-admin', async ({ api }) => {
					// Action
					const gqlResponse = await requestGraphQL(api.url, true, USER.APP_ACCESS!.TOKEN, {
						query: {
							server_info: {
								cairncms: {
									version: true,
								},
							},
						},
					});

					// Assert
					expect(gqlResponse.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_EXCEPTION');
				});

				test('unauthenticated', async ({ api }) => {
					// Action
					const gqlResponse = await requestGraphQL(api.url, true, null, {
						query: {
							server_info: {
								cairncms: {
									version: true,
								},
							},
						},
					});

					// Assert
					expect(gqlResponse.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_EXCEPTION');
				});
			});
		});
	});
});
