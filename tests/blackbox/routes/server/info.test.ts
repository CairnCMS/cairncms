import { getUrl } from '@common/config';
import * as common from '@common/index';
import request from 'supertest';
import vendors from '@common/get-dbs-to-test';
import { requestGraphQL } from '@common/transport';

describe('/server', () => {
	describe('GET /info', () => {
		describe('REST', () => {
			describe('Unauthenticated', () => {
				it.each(vendors)('%s', async (vendor) => {
					// Action
					const response = await request(getUrl(vendor)).get('/server/info');

					// Assert
					expect(response.statusCode).toBe(200);
					expect(response.body.data).not.toHaveProperty('cairncms');
					expect(response.body.data).not.toHaveProperty('node');
					expect(response.body.data).not.toHaveProperty('os');
				});
			});

			common.TEST_USERS.forEach((userKey) => {
				describe(common.USER[userKey].NAME, () => {
					it.each(vendors)('%s', async (vendor) => {
						// Action
						const response = await request(getUrl(vendor))
							.get('/server/info')
							.set('Authorization', `Bearer ${common.USER[userKey].TOKEN}`);

						// Assert
						expect(response.statusCode).toBe(200);
						expect(response.body.data).not.toHaveProperty('node');
						expect(response.body.data).not.toHaveProperty('os');
						expect(response.headers['cache-control']).toMatch(/no-cache|no-store/);

						if (userKey === common.USER.ADMIN.KEY) {
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
				it.each(vendors)('%s', async (vendor) => {
					// Action
					const gqlResponse = await requestGraphQL(getUrl(vendor), true, common.USER.ADMIN.TOKEN, {
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
				it.each(vendors)('%s', async (vendor) => {
					// Action
					const nodeResponse = await requestGraphQL(getUrl(vendor), true, common.USER.ADMIN.TOKEN, {
						query: {
							server_info: {
								node: {
									version: true,
								},
							},
						},
					});

					const osResponse = await requestGraphQL(getUrl(vendor), true, common.USER.ADMIN.TOKEN, {
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
				it.each(vendors)('non-admin (%s)', async (vendor) => {
					// Action
					const gqlResponse = await requestGraphQL(getUrl(vendor), true, common.USER.APP_ACCESS.TOKEN, {
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

				it.each(vendors)('unauthenticated (%s)', async (vendor) => {
					// Action
					const gqlResponse = await requestGraphQL(getUrl(vendor), true, null, {
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
