import { describe, expect } from 'vitest';
import { createIdentityTest } from '../../fixtures/identities';
import * as common from '../../fixtures/data';
import request from '../../fixtures/request';
import { sleep } from '../../utils/sleep';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';

initializeFixtures();

const test = createIdentityTest({
	env: { CACHE_ENABLED: 'true', CACHE_STORE: 'memory', CACHE_AUTO_PURGE: 'false', CACHE_STATUS_HEADER: 'X-Cache' },
});

async function waitForFlow(
	url: string,
	id: string,
	{
		method = 'get',
		manual = false,
		cacheDisabled = false,
	}: { method?: 'get' | 'post'; manual?: boolean; cacheDisabled?: boolean } = {}
): Promise<void> {
	const deadline = performance.now() + 5000;
	let last: Response | undefined;
	const ready = (response: Response) => response.status === 200 && typeof response.body?.epoch === 'number';

	let cause: unknown;

	try {
		while (performance.now() < deadline) {
			// Each probe uses a separate cache key, leaving the assertion requests' entries intact.
			const context = randomUUID();

			const trigger = () => {
				const probe = request(url)
					[method](`/flows/trigger/${id}`)
					.set('x-cairn-readiness', context)
					.timeout({ deadline: Math.max(1, deadline - performance.now()) });

				if (manual)
					probe.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`).send({ collection: 'directus_files' });
				return probe;
			};

			last = await trigger();

			if (ready(last)) {
				if (!cacheDisabled) return;
				// A 200 can still come from the previous configuration. Reuse only this probe's key.
				last = await trigger();
				if (ready(last) && last.headers['x-cache'] === 'MISS') return;
			}

			if (![200, 204, 403].includes(last.status)) break;
			await sleep(25);
		}
	} catch (error) {
		cause = error;
	}

	throw new Error(
		`Flow ${id} did not become ready${cacheDisabled ? ' with caching disabled' : ''}: ${JSON.stringify({
			status: last?.status,
			body: last?.body,
			cache: last?.headers['x-cache'],
			error: cause instanceof Error ? cause.message : cause,
		})}`,
		{ cause }
	);
}

describe('/flows', () => {
	describe('Webhook Trigger', () => {
		describe('cacheEnabled GET responses are segmented by request context', () => {
			test('REST', async ({ api }) => {
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
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				await request(api.url)
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await waitForFlow(api.url, flowId);
				const triggerPath = `/flows/trigger/${flowId}`;

				const alpha1 = await request(api.url).get(triggerPath).set('x-cairn-test', 'alpha');
				await sleep(100);
				const alpha2 = await request(api.url).get(triggerPath).set('x-cairn-test', 'alpha');

				await sleep(100);
				const beta1 = await request(api.url).get(triggerPath).set('x-cairn-test', 'beta');
				await sleep(100);
				const beta2 = await request(api.url).get(triggerPath).set('x-cairn-test', 'beta');

				await sleep(100);
				const query1 = await request(api.url).get(triggerPath).query({ nonce: '1' });
				await sleep(100);
				const query2 = await request(api.url).get(triggerPath).query({ nonce: '2' });

				const upperPath = `/FLOWS/TRIGGER/${flowId}`;
				const upperAlpha = await request(api.url).get(upperPath).set('x-cairn-test', 'alpha');
				await sleep(100);
				const upperBeta = await request(api.url).get(upperPath).set('x-cairn-test', 'beta');

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
			test('REST', async ({ api }) => {
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
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				const flowCacheEnabledId = (
					await request(api.url)
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
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send({
							...payloadFlowCreate,
							name: 'webhook flow cache enabled',
							options: { ...payloadFlowCreate.options, cacheEnabled: false },
						})
				).body.data.id;

				await request(api.url)
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await request(api.url)
					.patch(`/flows/${flowCacheEnabledId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowCacheEnabledId } });

				await request(api.url)
					.patch(`/flows/${flowCacheDisabledId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowCacheDisabledId } });

				for (const id of [flowId, flowCacheEnabledId, flowCacheDisabledId]) await waitForFlow(api.url, id);
				const responseDefault = await request(api.url).get(`/flows/trigger/${flowId}`);
				const responseCacheEnabled = await request(api.url).get(`/flows/trigger/${flowCacheEnabledId}`);
				const responseCacheDisabled = await request(api.url).get(`/flows/trigger/${flowCacheDisabledId}`);

				await sleep(100);

				const responseDefault2 = await request(api.url).get(`/flows/trigger/${flowId}`);
				const responseCacheEnabled2 = await request(api.url).get(`/flows/trigger/${flowCacheEnabledId}`);
				const responseCacheDisabled2 = await request(api.url).get(`/flows/trigger/${flowCacheDisabledId}`);

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
			test('REST', async ({ api }) => {
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
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				const flowCacheEnabledId = (
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send({
							...payloadFlowCreate,
							name: 'POST webhook flow cache enabled',
							options: { ...payloadFlowCreate.options, cacheEnabled: false },
						})
				).body.data.id;

				await request(api.url)
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await request(api.url)
					.patch(`/flows/${flowCacheEnabledId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowCacheEnabledId } });

				for (const id of [flowId, flowCacheEnabledId]) await waitForFlow(api.url, id, { method: 'post' });
				const responseDefault = await request(api.url).post(`/flows/trigger/${flowId}`);
				const responseCacheEnabled = await request(api.url).post(`/flows/trigger/${flowCacheEnabledId}`);

				await sleep(100);

				const responseDefault2 = await request(api.url).post(`/flows/trigger/${flowId}`);
				const responseCacheEnabled2 = await request(api.url).post(`/flows/trigger/${flowCacheEnabledId}`);

				expect(responseDefault.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheEnabled.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseDefault2.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
				expect(responseCacheEnabled2.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));

				expect(responseDefault.body).not.toEqual(responseDefault2.body);
				expect(responseCacheEnabled.body).not.toEqual(responseCacheEnabled2.body);
			});
		});

		describe('manual trigger payload survives the cache envelope unwrap', () => {
			test('REST', async ({ api }) => {
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
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				await request(api.url)
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await waitForFlow(api.url, flowId, { method: 'post', manual: true });

				const response = await request(api.url)
					.post(`/flows/trigger/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ collection: 'directus_files' });

				expect(response.status).toBe(200);
				expect(response.body).toEqual(expect.objectContaining({ epoch: expect.any(Number) }));
			});
		});

		describe('flipping cacheEnabled off does not evict an existing cached entry when CACHE_AUTO_PURGE is false', () => {
			test('REST', async ({ api }) => {
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
					await request(api.url)
						.post('/flows')
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
						.query({ fields: ['id'] })
						.send(payloadFlowCreate)
				).body.data.id;

				await request(api.url)
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ operation: { ...payloadOperationCreate, flow: flowId } });

				await waitForFlow(api.url, flowId);
				const responseInitial = await request(api.url).get(`/flows/trigger/${flowId}`);

				await sleep(100);

				const responseCacheHit = await request(api.url).get(`/flows/trigger/${flowId}`);

				await request(api.url)
					.patch(`/flows/${flowId}`)
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
					.send({ options: { cacheEnabled: false } });

				await waitForFlow(api.url, flowId, { cacheDisabled: true });

				const responseAfterFlip = await request(api.url).get(`/flows/trigger/${flowId}`);

				await request(api.url).post('/utils/cache/clear').set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				await sleep(100);

				const responseAfterClear = await request(api.url).get(`/flows/trigger/${flowId}`);

				await sleep(100);

				const responseFresh = await request(api.url).get(`/flows/trigger/${flowId}`);

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
