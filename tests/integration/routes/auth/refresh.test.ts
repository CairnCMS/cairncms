import { describe, expect } from 'vitest';
import { identityTest as test, USER, TEST_USERS } from '../../fixtures/identities';
import request, { requestGraphQL } from '../../fixtures/request';
import { EnumType } from 'json-to-graphql-query';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const authModes = ['json', 'cookie'];

describe('Authentication Refresh Tests', () => {
	describe('POST /refresh', () => {
		describe('refreshes with refresh_token in the body', () => {
			describe.each(authModes)('for %s mode', (mode) => {
				TEST_USERS.forEach((userKey) => {
					describe(USER[userKey]!.NAME, () => {
						test('REST and GraphQL', async ({ api }) => {
							// Setup
							const refreshToken = (
								await request(api.url)
									.post(`/auth/login`)
									.send({ email: USER[userKey]!.EMAIL, password: USER[userKey]!.PASSWORD })
									.expect('Content-Type', /application\/json/)
							).body.data.refresh_token;

							const refreshToken2 = (
								await requestGraphQL(api.url, true, null, {
									mutation: {
										auth_login: {
											__args: {
												email: USER[userKey]!.EMAIL,
												password: USER[userKey]!.PASSWORD,
											},
											refresh_token: true,
										},
									},
								})
							).body.data.auth_login.refresh_token;

							// Action
							const response = await request(api.url)
								.post(`/auth/refresh`)
								.send({ refresh_token: refreshToken, mode })
								.expect('Content-Type', /application\/json/);

							const mutationKey = 'auth_refresh';

							const gqlResponse = await requestGraphQL(api.url, true, null, {
								mutation: {
									[mutationKey]: {
										__args: {
											refresh_token: refreshToken2,
											mode: new EnumType(mode),
										},
										access_token: true,
										expires: true,
										refresh_token: true,
									},
								},
							});

							// Assert
							expect(response.statusCode).toBe(200);

							if (mode === 'cookie') {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
									},
								});
							} else {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
										refresh_token: expect.any(String),
									},
								});
							}

							expect(gqlResponse.statusCode).toBe(200);

							expect(gqlResponse.body).toMatchObject({
								data: {
									[mutationKey]: {
										access_token: expect.any(String),
										expires: expect.any(String),
										refresh_token: expect.any(String),
									},
								},
							});
						});
					});
				});
			});
		});

		describe('refreshes with refresh_token in the cookie', () => {
			describe.each(authModes)('for %s mode', (mode) => {
				TEST_USERS.forEach((userKey) => {
					describe(USER[userKey]!.NAME, () => {
						test('REST and GraphQL', async ({ api }) => {
							// Setup
							const cookieName = 'cairncms_refresh_token';

							const refreshToken = (
								await request(api.url)
									.post(`/auth/login`)
									.send({ email: USER[userKey]!.EMAIL, password: USER[userKey]!.PASSWORD })
									.expect('Content-Type', /application\/json/)
							).body.data.refresh_token;

							const refreshToken2 = (
								await requestGraphQL(api.url, true, null, {
									mutation: {
										auth_login: {
											__args: {
												email: USER[userKey]!.EMAIL,
												password: USER[userKey]!.PASSWORD,
											},
											refresh_token: true,
										},
									},
								})
							).body.data.auth_login.refresh_token;

							// Action
							const response = await request(api.url)
								.post(`/auth/refresh`)
								.set('Cookie', `${cookieName}=${refreshToken}`)
								.send({ mode })
								.expect('Content-Type', /application\/json/);

							const mutationKey = 'auth_refresh';

							const gqlResponse = await requestGraphQL(
								api.url,
								true,
								null,
								{
									mutation: {
										[mutationKey]: {
											__args: {
												refresh_token: refreshToken2,
												mode: new EnumType(mode),
											},
											access_token: true,
											expires: true,
											refresh_token: true,
										},
									},
								},
								{ cookies: [`${cookieName}=${refreshToken2}`] }
							);

							// Assert
							expect(response.statusCode).toBe(200);

							if (mode === 'cookie') {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
									},
								});
							} else {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
										refresh_token: expect.any(String),
									},
								});
							}

							expect(gqlResponse.statusCode).toBe(200);

							expect(gqlResponse.body).toMatchObject({
								data: {
									[mutationKey]: {
										access_token: expect.any(String),
										expires: expect.any(String),
										refresh_token: expect.any(String),
									},
								},
							});
						});
					});
				});
			});
		});
	});
});
