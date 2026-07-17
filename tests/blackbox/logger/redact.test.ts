import config, { getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { TestLogger } from '@common/test-logger';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { EnumType } from 'json-to-graphql-query';
import type { Knex } from 'knex';
import knex from 'knex';
import { cloneDeep } from 'lodash';
import request from 'supertest';

const ERROR_SINK_ENDPOINT = '/cairncms-extension-error-sink/throw';

const KEYED_SECRET = 'keyed-extension-secret-7b3d1e5f';

interface ErrorLogRecord {
	err: { message: string; extensions?: Record<string, unknown> };
}

function isErrorLogRecord(value: unknown): value is ErrorLogRecord {
	if (typeof value !== 'object' || value === null || !('err' in value)) return false;
	const err = (value as { err: unknown }).err;
	return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string';
}

function findErrorRecord(logs: string, needle: string): ErrorLogRecord | undefined {
	for (const line of logs.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		let record: unknown;

		try {
			record = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (isErrorLogRecord(record) && record.err.message.includes(needle)) return record;
	}

	return undefined;
}

describe('Logger Redact Tests', () => {
	const databases = new Map<string, Knex>();
	const directusInstances = {} as { [vendor: string]: ChildProcess };
	const env = cloneDeep(config.envs);
	const authModes = ['json', 'cookie'];

	for (const vendor of vendors) {
		env[vendor].LOG_STYLE = 'raw';
		env[vendor].LOG_LEVEL = 'info';
		env[vendor].PORT = String(Number(env[vendor]!.PORT) + 500);
	}

	beforeAll(async () => {
		const promises = [];

		for (const vendor of vendors) {
			databases.set(vendor, knex(config.knexConfig[vendor]!));

			const server = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], { cwd: paths.cwd, env: env[vendor] });
			directusInstances[vendor] = server;

			promises.push(awaitDirectusConnection(Number(env[vendor].PORT)));
		}

		// Give the server some time to start
		await Promise.all(promises);
	}, 300000);

	afterAll(async () => {
		for (const [vendor, connection] of databases) {
			directusInstances[vendor]!.kill();

			await connection.destroy();
		}
	});

	describe('POST /refresh', () => {
		describe('refreshes with refresh_token in the body', () => {
			describe.each(authModes)('for %s mode', (mode) => {
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						it.each(vendors)('%s', async (vendor) => {
							// Setup
							const refreshToken = (
								await request(getUrl(vendor, env))
									.post(`/auth/login`)
									.send({ email: common.USER[userKey].EMAIL, password: common.USER[userKey].PASSWORD })
									.expect('Content-Type', /application\/json/)
							).body.data.refresh_token;

							const refreshToken2 = (
								await common.requestGraphQL(getUrl(vendor, env), true, null, {
									mutation: {
										auth_login: {
											__args: {
												email: common.USER[userKey].EMAIL,
												password: common.USER[userKey].PASSWORD,
											},
											refresh_token: true,
										},
									},
								})
							).body.data.auth_login.refresh_token;

							// Action
							const logger = new TestLogger(directusInstances[vendor], '/auth/refresh', true);

							const response = await request(getUrl(vendor, env))
								.post(`/auth/refresh`)
								.send({ refresh_token: refreshToken, mode })
								.expect('Content-Type', /application\/json/);

							const logs = await logger.getLogs();

							const loggerGql = new TestLogger(directusInstances[vendor], '/graphql/system', true);

							const mutationKey = 'auth_refresh';

							const gqlResponse = await common.requestGraphQL(getUrl(vendor, env), true, null, {
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

							const logsGql = await loggerGql.getLogs();

							// Assert
							expect(response.statusCode).toBe(200);

							if (mode === 'cookie') {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
									},
								});

								for (const log of [logs, logsGql]) {
									expect((log.match(/"cookie":"--redact--"/g) || []).length).toBe(0);
									expect((log.match(/"set-cookie":"--redact--"/g) || []).length).toBe(1);
								}
							} else {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
										refresh_token: expect.any(String),
									},
								});

								for (const log of [logs, logsGql]) {
									expect((log.match(/"cookie":"--redact--"/g) || []).length).toBe(0);
									expect((log.match(/"set-cookie":"--redact--"/g) || []).length).toBe(0);
								}
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
				common.TEST_USERS.forEach((userKey) => {
					describe(common.USER[userKey].NAME, () => {
						it.each(vendors)('%s', async (vendor) => {
							// Setup
							const cookieName = common.REFRESH_TOKEN_COOKIE_NAME;

							const refreshToken = (
								await request(getUrl(vendor, env))
									.post(`/auth/login`)
									.send({ email: common.USER[userKey].EMAIL, password: common.USER[userKey].PASSWORD })
									.expect('Content-Type', /application\/json/)
							).body.data.refresh_token;

							const refreshToken2 = (
								await common.requestGraphQL(getUrl(vendor, env), true, null, {
									mutation: {
										auth_login: {
											__args: {
												email: common.USER[userKey].EMAIL,
												password: common.USER[userKey].PASSWORD,
											},
											refresh_token: true,
										},
									},
								})
							).body.data.auth_login.refresh_token;

							// Action
							const logger = new TestLogger(directusInstances[vendor], '/auth/refresh', true);

							const response = await request(getUrl(vendor, env))
								.post(`/auth/refresh`)
								.set('Cookie', `${cookieName}=${refreshToken}`)
								.send({ mode })
								.expect('Content-Type', /application\/json/);

							const logs = await logger.getLogs();

							const loggerGql = new TestLogger(directusInstances[vendor], '/graphql/system', true);

							const mutationKey = 'auth_refresh';

							const gqlResponse = await common.requestGraphQL(
								getUrl(vendor, env),
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

							const logsGql = await loggerGql.getLogs();

							// Assert
							expect(response.statusCode).toBe(200);

							if (mode === 'cookie') {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
									},
								});

								for (const log of [logs, logsGql]) {
									expect((log.match(/"cookie":"--redact--"/g) || []).length).toBe(1);
									expect((log.match(/"set-cookie":"--redact--"/g) || []).length).toBe(1);
								}
							} else {
								expect(response.body).toMatchObject({
									data: {
										access_token: expect.any(String),
										expires: expect.any(Number),
										refresh_token: expect.any(String),
									},
								});

								for (const log of [logs, logsGql]) {
									expect((log.match(/"cookie":"--redact--"/g) || []).length).toBe(1);
									expect((log.match(/"set-cookie":"--redact--"/g) || []).length).toBe(0);
								}
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

	describe('REST error sink', () => {
		it.each(vendors)(
			'%s redacts a propagated request secret and a keyed extension secret in the response and the log',
			async (vendor) => {
				const propagatedSecret = 'propagated-body-secret-4f9a2c1d';

				const logger = new TestLogger(directusInstances[vendor], ERROR_SINK_ENDPOINT);

				const response = await request(getUrl(vendor, env))
					.post(ERROR_SINK_ENDPOINT)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ password: propagatedSecret })
					.expect('Content-Type', /application\/json/)
					.expect(500);

				const logs = await logger.getLogs();

				const error = response.body.errors[0];
				expect(error.message).toBe('error-sink endpoint failure echoing --redact--');
				expect(error.extensions.code).toBe('INTERNAL_SERVER_ERROR');
				expect(error.extensions.detail).toBe('propagated request value was --redact--');
				expect(error.extensions.token).toBe('--redact--');

				const responseText = JSON.stringify(response.body);
				expect(responseText).not.toContain(propagatedSecret);
				expect(responseText).not.toContain(KEYED_SECRET);

				const errorRecord = findErrorRecord(logs, 'error-sink endpoint failure');
				expect(errorRecord).toBeDefined();
				expect(errorRecord?.err.message).toBe('error-sink endpoint failure echoing --redact--');
				expect(errorRecord?.err.extensions?.detail).toBe('propagated request value was --redact--');
				expect(errorRecord?.err.extensions?.token).toBe('--redact--');
				expect(logs).not.toContain(propagatedSecret);
				expect(logs).not.toContain(KEYED_SECRET);
			},
			60000
		);
	});

	describe('GraphQL error sink', () => {
		it.each(vendors)(
			'%s redacts a variable secret echoed in a coercion error in the response and the log',
			async (vendor) => {
				const variableSecret = 'graphql-variable-secret-8c2f1a3b';

				const logger = new TestLogger(directusInstances[vendor], '/graphql/system');

				const response = await request(getUrl(vendor, env))
					.post('/graphql/system')
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({
						query: 'query ($password: Int) { users(limit: $password) { id } }',
						variables: { password: variableSecret },
					})
					.expect('Content-Type', /application\/json/)
					.expect(200);

				const logs = await logger.getLogs();

				const error = response.body.errors[0];
				expect(error.message).toContain('got invalid value "--redact--"');

				const responseText = JSON.stringify(response.body);
				expect(responseText).not.toContain(variableSecret);

				const errorRecord = findErrorRecord(logs, 'got invalid value');
				expect(errorRecord).toBeDefined();
				expect(errorRecord?.err.message).toContain('got invalid value "--redact--"');
				expect(logs).not.toContain(variableSecret);
			},
			60000
		);
	});
});
