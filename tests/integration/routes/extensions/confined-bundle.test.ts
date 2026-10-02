import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { requestGraphQL } from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import type { Test } from 'supertest';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const BUNDLE = 'cairncms-extension-confined-bundle';
const COLLECTION = 'confined_bundle_records';
const OP_TYPE = 'confined-bundle-op';
const READER_ENDPOINT = 'confined-bundle-reader';
const BARE_ENDPOINT = 'confined-bundle-bare';

const PROBE_FLOW = {
	status: 'active',
	trigger: 'webhook',
	accountability: 'all',
	options: { method: 'POST', async: false },
};

function admin(req: Test): Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`);
}

async function awaitFlowReady(api: Api, flowId: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const response = await request(api.url).post(`/flows/trigger/${flowId}`).send({ probe: 'ready' });
		if (response.status === 200 && response.body !== null && response.body.marker === OP_TYPE) return;
		await sleep(100);
	}

	throw new Error(`the confined bundle operation flow ${flowId} never produced a result`);
}

const test = createIdentityTest({ extensions: [BUNDLE] }).extend<{
	schemaState: Prerequisite<void>;
	schema: void;
	clean: void;
	probe: { flowId: string };
}>({
	schemaState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					const inventory = await admin(setupRequest(api.url).get('/extensions')).expect(200);
					const row = inventory.body.data.find((item: { name: string }) => item.name === BUNDLE);
					for (const name of [OP_TYPE, READER_ENDPOINT, BARE_ENDPOINT, 'confined-bundle-hook'])
						expect(row.entries.find((entry: { name: string }) => entry.name === name)?.status).toBe('loaded');

					await admin(setupRequest(api.url).post('/collections'))
						.send({
							collection: COLLECTION,
							meta: {},
							schema: {},
							fields: [
								...['title', 'stamped', 'stamped_by'].map((field) => ({ field, type: 'string', meta: {}, schema: {} })),
								{
									field: 'id',
									type: 'integer',
									meta: { hidden: true, interface: 'input', readonly: true },
									schema: { is_primary_key: true, has_auto_increment: true },
								},
							],
						})
						.expect(200);

					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	schema: [
		async ({ api, identities, schemaState, task, skip }, use) => {
			void api;
			void identities;
			requirePrerequisite(schemaState, 'confined bundle schema and entries', { task, skip });
			await use();
		},
		{ auto: true },
	],
	clean: [
		async ({ api, schema }, use) => {
			void schema;
			await api.database(COLLECTION).delete();
			await use();
		},
		{ auto: true },
	],
	probe: async ({ api, schema, teardownFailures }, use) => {
		void schema;

		const flow = await admin(setupRequest(api.url).post('/flows'))
			.send({ name: `confined bundle operation probe ${randomUUID()}`, ...PROBE_FLOW })
			.expect(200);

		const flowId: string = flow.body.data.id;
		expect(typeof flowId).toBe('string');

		try {
			const operation = await admin(setupRequest(api.url).post('/operations'))
				.send({
					flow: flowId,
					name: 'probe',
					key: 'probe',
					type: OP_TYPE,
					position_x: 1,
					position_y: 1,
					options: { probe: '{{$trigger.body.probe}}' },
				})
				.expect(200);

			await admin(setupRequest(api.url).patch(`/flows/${flowId}`))
				.send({ ...PROBE_FLOW, operation: operation.body.data.id })
				.expect(200);

			await awaitFlowReady(api, flowId);
			await use({ flowId });
		} finally {
			try {
				await admin(setupRequest(api.url).delete(`/flows/${flowId}`)).expect(204);
			} catch (error) {
				teardownFailures.push(error);
			}
		}
	},
});

describe('Confined bundle server entries through the real binding', () => {
	describe('fixture registration', () => {
		test('loads every server entry from the one bundle artifact', async ({ api }) => {
			const response = await admin(request(api.url).get('/extensions')).expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			const row = byName[BUNDLE];
			expect(row?.status).toBe('loaded');

			const byEntry = Object.fromEntries(
				(row.entries ?? []).map((entry: { name: string; type: string }) => [`${entry.type}:${entry.name}`, entry])
			);

			expect(byEntry['operation:confined-bundle-op']?.status).toBe('loaded');
			expect(byEntry['endpoint:confined-bundle-reader']?.status).toBe('loaded');
			expect(byEntry['endpoint:confined-bundle-bare']?.status).toBe('loaded');
			expect(byEntry['hook:confined-bundle-hook']?.status).toBe('loaded');
		});
	});

	describe('per-entry capability isolation', () => {
		test('grants items to the declaring endpoint and denies its sibling from the same artifact', async ({
			api,
			vendor,
		}) => {
			const created = await admin(request(api.url).post(`/items/${COLLECTION}`)).send({
				title: `isolation-${vendor}`,
			});

			expect(created.status).toBe(200);

			// The reader entry declared the items capability, so its read succeeds.
			const reader = await admin(request(api.url).post(`/${READER_ENDPOINT}/read`)).send({
				collection: COLLECTION,
				query: { fields: ['title', 'stamped'], limit: 10 },
			});

			expect(reader.status).toBe(200);
			expect(reader.body.ok).toBe(true);
			expect(Array.isArray(reader.body.value)).toBe(true);
			expect(reader.body.value.length).toBeGreaterThan(0);

			// The sibling entry ran the identical handler from the same artifact but
			// declared no items capability, so the broker denies the read. The query is
			// broker-valid so the denial proves the missing capability, not bad input.
			const bare = await admin(request(api.url).post(`/${BARE_ENDPOINT}/read`)).send({
				collection: COLLECTION,
				query: { fields: ['title'], limit: 10 },
			});

			expect(bare.status).toBe(200);
			expect(bare.body.ok).toBe(false);
			expect(bare.body.error.code).toBe('denied');
		}, 60000);
	});

	describe('hook entry transforms through a real child', () => {
		test('stamps a created item through the bundle hook entry', async ({ api, vendor }) => {
			const title = `hooked-${vendor}`;

			const created = await admin(request(api.url).post(`/items/${COLLECTION}`)).send({ title });

			expect(created.status).toBe(200);

			const stored = await admin(
				request(api.url)
					.get(`/items/${COLLECTION}/${created.body.data.id}`)
					.query({ fields: ['title', 'stamped', 'stamped_by'] })
			);

			expect(stored.status).toBe(200);
			expect(stored.body.data.title).toBe(title);
			expect(stored.body.data.stamped).toBe('by-confined-bundle-hook');

			// The event accountability reached the guest: the stamp carries the caller.
			expect(typeof stored.body.data.stamped_by).toBe('string');
			expect(stored.body.data.stamped_by.length).toBeGreaterThan(0);
		}, 60000);
	});

	describe('operation entry runs through a real child', () => {
		test('runs the bundle operation entry from the same artifact', async ({ api, probe }) => {
			const triggered = await request(api.url).post(`/flows/trigger/${probe.flowId}`).send({ probe: 'pong' });

			expect(triggered.status).toBe(200);
			expect(triggered.body).toMatchObject({ marker: OP_TYPE, received: 'pong' });
		}, 60000);
	});

	describe('operation secret options through the at-rest contract', () => {
		const SECRET_MASK = '**********';
		const PLAINTEXT = 'sk_live_blackbox_flow_secret';

		async function operationId(api: Api, flowId: string): Promise<string> {
			const found = await admin(
				request(api.url)
					.get('/operations')
					.query({ filter: { flow: { _eq: flowId } }, fields: ['id'], limit: -1 })
			);

			return found.body.data[0].id;
		}

		async function storedOptions(api: Api, id: string): Promise<Record<string, any>> {
			const row = await api.database('directus_operations').where({ id }).first();
			return typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
		}

		async function triggerUntilSecretReady(api: Api, flowId: string, probe: string): Promise<Record<string, any>> {
			for (let attempt = 0; attempt < 50; attempt++) {
				const response = await request(api.url).post(`/flows/trigger/${flowId}`).send({ probe });

				if (response.status === 200 && response.body?.apiKeyKind === 'secret-reference') return response.body;

				await sleep(100);
			}

			throw new Error('the operation never received its secret as a reference');
		}

		test('encrypts at rest, masks every external read, preserves on mask resave, and delivers a reference', async ({
			api,
			probe,
		}) => {
			const id = await operationId(api, probe.flowId);

			const written = await admin(request(api.url).patch(`/operations/${id}`)).send({
				options: { probe: '{{$trigger.body.probe}}', api_key: PLAINTEXT },
			});

			expect(written.status).toBe(200);
			expect(written.body.data.options.api_key).toBe(SECRET_MASK);
			expect(JSON.stringify(written.body)).not.toContain(PLAINTEXT);

			const atRest = await storedOptions(api, id);
			expect(atRest.api_key.kind).toBe('cairncms-secret-envelope');
			expect(JSON.stringify(atRest)).not.toContain(PLAINTEXT);

			const read = await admin(
				request(api.url)
					.get(`/operations/${id}`)
					.query({ fields: ['type', 'options'] })
			);

			expect(read.status).toBe(200);
			expect(read.body.data.options.api_key).toBe(SECRET_MASK);
			expect(read.body.data.options.probe).toBe('{{$trigger.body.probe}}');
			expect(JSON.stringify(read.body)).not.toContain(PLAINTEXT);

			const nested = await admin(
				request(api.url)
					.get(`/flows/${probe.flowId}`)
					.query({ fields: ['*', 'operations.*'] })
			);

			expect(nested.status).toBe(200);

			const nestedOperation = nested.body.data.operations.find((operation: { id: string }) => operation.id === id);
			expect(nestedOperation.options.api_key).toBe(SECRET_MASK);
			expect(JSON.stringify(nested.body)).not.toContain(PLAINTEXT);

			const gql = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
				query: {
					operations: {
						__args: { filter: { id: { _eq: id } } },
						type: true,
						options: true,
					},
				},
			});

			expect(gql.statusCode).toBe(200);
			const gqlOptions = gql.body.data.operations[0].options;
			const gqlParsed = typeof gqlOptions === 'string' ? JSON.parse(gqlOptions) : gqlOptions;
			expect(gqlParsed.api_key).toBe(SECRET_MASK);
			expect(JSON.stringify(gql.body)).not.toContain(PLAINTEXT);

			const patchRevision = await admin(
				request(api.url)
					.get('/revisions')
					.query({
						filter: { collection: { _eq: 'directus_operations' }, item: { _eq: id } },
						sort: '-id',
						limit: 1,
					})
			);

			expect(patchRevision.status).toBe(200);
			expect(patchRevision.body.data.length).toBe(1);
			expect(JSON.stringify(patchRevision.body)).not.toContain(PLAINTEXT);

			const resaved = await admin(request(api.url).patch(`/operations/${id}`)).send({
				options: { probe: '{{$trigger.body.probe}}', api_key: SECRET_MASK },
			});

			expect(resaved.status).toBe(200);

			const preserved = await storedOptions(api, id);
			expect(preserved.api_key.ct).toBe(atRest.api_key.ct);

			const outcome = await triggerUntilSecretReady(api, probe.flowId, 'secret-run');
			expect(outcome).toMatchObject({ marker: OP_TYPE, received: 'secret-run', apiKeyKind: 'secret-reference' });
			expect(JSON.stringify(outcome)).not.toContain(PLAINTEXT);

			const runRevision = await admin(
				request(api.url)
					.get('/revisions')
					.query({
						filter: { collection: { _eq: 'directus_flows' }, item: { _eq: probe.flowId } },
						sort: '-id',
						limit: 1,
					})
			);

			expect(runRevision.status).toBe(200);
			expect(runRevision.body.data.length).toBe(1);
			expect(JSON.stringify(runRevision.body)).not.toContain(PLAINTEXT);
		}, 120000);

		test('rejects a mask write with no stored secret behind it', async ({ api, probe }) => {
			const id = await operationId(api, probe.flowId);

			await admin(request(api.url).patch(`/operations/${id}`))
				.send({ options: { probe: '{{$trigger.body.probe}}', api_key: PLAINTEXT } })
				.expect(200);

			const beforeClear = await storedOptions(api, id);
			expect(beforeClear.api_key).toMatchObject({ kind: 'cairncms-secret-envelope' });
			expect(typeof beforeClear.api_key.ct).toBe('string');
			expect(JSON.stringify(beforeClear)).not.toContain(PLAINTEXT);

			const cleared = await admin(request(api.url).patch(`/operations/${id}`)).send({
				options: { probe: '{{$trigger.body.probe}}', api_key: '' },
			});

			expect(cleared.status).toBe(200);
			expect((await storedOptions(api, id)).api_key).toBe('');
			expect(JSON.stringify(cleared.body)).not.toContain(PLAINTEXT);

			const masked = await admin(request(api.url).patch(`/operations/${id}`)).send({
				options: { probe: '{{$trigger.body.probe}}', api_key: SECRET_MASK },
			});

			expect(masked.status).toBe(400);
		}, 60000);
	});
});
