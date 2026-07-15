import config, { Env, getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import request from 'supertest';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import knex from 'knex';
import type { Knex } from 'knex';
import { cloneDeep } from 'lodash';
import { sleep } from '@utils/sleep';

describe('/flows', () => {
	const databases = new Map<string, Knex>();
	const directusInstances = {} as { [vendor: string]: ChildProcess };
	const envs = {} as { [vendor: string]: Env };

	beforeAll(async () => {
		const promises = [];

		for (const vendor of vendors) {
			databases.set(vendor, knex(config.knexConfig[vendor]!));

			const env = cloneDeep(config.envs);
			env[vendor].CACHE_ENABLED = 'true';
			env[vendor].CACHE_STORE = 'memory';
			env[vendor].CACHE_AUTO_PURGE = 'false';

			const newServerPort = Number(env[vendor]!.PORT) + 150;
			env[vendor]!.PORT = String(newServerPort);

			const server = spawn('node', [paths.cli, 'start'], { cwd: paths.cwd, env: env[vendor] });

			directusInstances[vendor] = server;
			envs[vendor] = env;

			promises.push(awaitDirectusConnection(newServerPort));
		}

		await Promise.all(promises);
	}, 180000);

	afterAll(async () => {
		for (const [vendor, connection] of databases) {
			directusInstances[vendor].kill();
			await connection.destroy();
		}
	});

	describe('Webhook Trigger', () => {
		describe('cacheEnabled GET responses are segmented by request context', () => {
			it.each(vendors)('%s', async (vendor) => {
				const env = envs[vendor];

				const payloadFlowCreate = {
					name: 'request-context segmentation flow',
					icon: 'bolt',
					color: null,
					description: null,
					status: 'active',
					accountability: null,
					trigger: 'webhook',
					options: {},
				};

				const payloadOperationCreate = {
					position_x: 19,
					position_y: 1,
					name: 'Get epoch milliseconds',
					key: 'op_exev',
					type: 'exec',
					options: { code: 'module.exports = async function() { return { epoch: Date.now() }; }' },
				};

				const flowId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				const triggerPath = `/flows/trigger/${flowId}`;

				const alpha1 = await request(getUrl(vendor, env)).get(triggerPath).set('x-cairn-test', 'alpha');
				await sleep(100);
				const alpha2 = await request(getUrl(vendor, env)).get(triggerPath).set('x-cairn-test', 'alpha');

				await sleep(100);
				const beta1 = await request(getUrl(vendor, env)).get(triggerPath).set('x-cairn-test', 'beta');
				await sleep(100);
				const beta2 = await request(getUrl(vendor, env)).get(triggerPath).set('x-cairn-test', 'beta');

				await sleep(100);
				const query1 = await request(getUrl(vendor, env)).get(triggerPath).query({ nonce: '1' });
				await sleep(100);
				const query2 = await request(getUrl(vendor, env)).get(triggerPath).query({ nonce: '2' });

				const upperPath = `/FLOWS/TRIGGER/${flowId}`;
				const upperAlpha = await request(getUrl(vendor, env)).get(upperPath).set('x-cairn-test', 'alpha');
				await sleep(100);
				const upperBeta = await request(getUrl(vendor, env)).get(upperPath).set('x-cairn-test', 'beta');

				for (const response of [alpha1, alpha2, beta1, beta2, query1, query2, upperAlpha, upperBeta]) {
					expect(response.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				}

				expect(alpha1.body.epoch).toEqual(alpha2.body.epoch);
				expect(beta1.body.epoch).toEqual(beta2.body.epoch);
				expect(alpha1.body.epoch).not.toEqual(beta1.body.epoch);
				expect(query1.body.epoch).not.toEqual(query2.body.epoch);
				expect(upperAlpha.body.epoch).not.toEqual(upperBeta.body.epoch);

				expect(alpha1.headers['cache-control']).toBe('no-store');
				expect(alpha2.headers['cache-control']).toBe('no-store');
			});
		});

		describe('cacheEnabled works for GET', () => {
			it.each(vendors)('%s', async (vendor) => {
				const env = envs[vendor];

				const payloadFlowCreate = {
					name: 'webhook flow',
					icon: 'bolt',
					color: null,
					description: null,
					status: 'active',
					accountability: null,
					trigger: 'webhook',
					options: {},
				};

				const payloadOperationCreate = {
					position_x: 19,
					position_y: 1,
					name: 'Get epoch milliseconds',
					key: 'op_exev',
					type: 'exec',
					options: { code: 'module.exports = async function() { return { epoch: Date.now() }; }' },
				};

				const flowId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				const flowCacheEnabledId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send({
							...payloadFlowCreate,
							name: 'webhook flow cache disabled',
							options: { ...payloadFlowCreate.options, cacheEnabled: true },
						})
				).body.data.id;

				const flowCacheDisabledId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send({
							...payloadFlowCreate,
							name: 'webhook flow cache enabled',
							options: { ...payloadFlowCreate.options, cacheEnabled: false },
						})
				).body.data.id;

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowCacheEnabledId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowCacheEnabledId } });

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowCacheDisabledId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowCacheDisabledId } });

				const responseDefault = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);
				const responseCacheEnabled = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowCacheEnabledId}`);
				const responseCacheDisabled = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowCacheDisabledId}`);

				await sleep(100);

				const responseDefault2 = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);
				const responseCacheEnabled2 = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowCacheEnabledId}`);
				const responseCacheDisabled2 = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowCacheDisabledId}`);

				expect(responseDefault.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheEnabled.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheDisabled.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseDefault2.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheEnabled.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheDisabled2.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));

				expect(responseDefault.body).toEqual(responseDefault2.body);
				expect(responseCacheEnabled.body).toEqual(responseCacheEnabled2.body);
				expect(responseCacheDisabled.body).not.toEqual(responseCacheDisabled2.body);
			});
		});

		describe('ignores cacheEnabled for POST', () => {
			it.each(vendors)('%s', async (vendor) => {
				const env = envs[vendor];

				const payloadFlowCreate = {
					name: 'POST webhook flow',
					icon: 'bolt',
					color: null,
					description: null,
					status: 'active',
					accountability: null,
					trigger: 'webhook',
					options: { method: 'POST' },
				};

				const payloadOperationCreate = {
					position_x: 19,
					position_y: 1,
					name: 'Get epoch milliseconds',
					key: 'op_exev',
					type: 'exec',
					options: { code: 'module.exports = async function() { return { epoch: Date.now() }; }' },
				};

				const flowId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				const flowCacheEnabledId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send({
							...payloadFlowCreate,
							name: 'POST webhook flow cache enabled',
							options: { ...payloadFlowCreate.options, cacheEnabled: false },
						})
				).body.data.id;

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowCacheEnabledId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowCacheEnabledId } });

				const responseDefault = await request(getUrl(vendor, env)).post(`/flows/trigger/${flowId}`);
				const responseCacheEnabled = await request(getUrl(vendor, env)).post(`/flows/trigger/${flowCacheEnabledId}`);

				await sleep(100);

				const responseDefault2 = await request(getUrl(vendor, env)).post(`/flows/trigger/${flowId}`);
				const responseCacheEnabled2 = await request(getUrl(vendor, env)).post(`/flows/trigger/${flowCacheEnabledId}`);

				expect(responseDefault.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheEnabled.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseDefault2.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheEnabled2.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));

				expect(responseDefault.body).not.toEqual(responseDefault2.body);
				expect(responseCacheEnabled.body).not.toEqual(responseCacheEnabled2.body);
			});
		});

		describe('manual trigger payload survives the cache envelope unwrap', () => {
			it.each(vendors)('%s', async (vendor) => {
				const env = envs[vendor];

				const payloadFlowCreate = {
					name: 'manual flow envelope regression',
					icon: 'bolt',
					color: null,
					description: null,
					status: 'active',
					accountability: null,
					trigger: 'manual',
					options: { collections: ['directus_files'], requireSelection: false },
				};

				const payloadOperationCreate = {
					position_x: 19,
					position_y: 1,
					name: 'Get epoch milliseconds',
					key: 'op_exev',
					type: 'exec',
					options: { code: 'module.exports = async function() { return { epoch: Date.now() }; }' },
				};

				const flowId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				const response = await request(getUrl(vendor, env))
					.post(`/flows/trigger/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ collection: 'directus_files' });

				expect(response.status).toBe(200);
				expect(response.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
			});
		});

		describe('flipping cacheEnabled off does not evict an existing cached entry when CACHE_AUTO_PURGE is false', () => {
			it.each(vendors)('%s', async (vendor) => {
				const env = envs[vendor];

				const payloadFlowCreate = {
					name: 'stale-hit demonstration flow',
					icon: 'bolt',
					color: null,
					description: null,
					status: 'active',
					accountability: null,
					trigger: 'webhook',
					options: {},
				};

				const payloadOperationCreate = {
					position_x: 19,
					position_y: 1,
					name: 'Get epoch milliseconds',
					key: 'op_exev',
					type: 'exec',
					options: { code: 'module.exports = async function() { return { epoch: Date.now() }; }' },
				};

				const flowId = (
					await request(getUrl(vendor, env))
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				const responseInitial = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);

				await sleep(100);

				const responseCacheHit = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);

				await request(getUrl(vendor, env))
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ options: { cacheEnabled: false } });

				await sleep(100);

				const responseAfterFlip = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);

				await request(getUrl(vendor, env))
					.post('/utils/cache/clear')
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				await sleep(100);

				const responseAfterClear = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);

				await sleep(100);

				const responseFresh = await request(getUrl(vendor, env)).get(`/flows/trigger/${flowId}`);

				expect(responseInitial.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheHit.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseAfterFlip.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseAfterClear.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseFresh.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));

				expect(responseInitial.body).toEqual(responseCacheHit.body);
				expect(responseAfterFlip.body).toEqual(responseInitial.body);
				expect(responseAfterClear.body).not.toEqual(responseInitial.body);
				expect(responseFresh.body).not.toEqual(responseAfterClear.body);
			});
		});
	});
});
