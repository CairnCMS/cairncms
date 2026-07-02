import config, { getUrl } from '@common/config';
import { CreateCollection } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
import knex, { type Knex } from 'knex';
import request from 'supertest';
import { sleep } from '@utils/sleep';

const BUNDLE = 'cairncms-extension-confined-bundle';
const COLLECTION = 'confined_bundle_records';
const OP_TYPE = 'confined-bundle-op';
const READER_ENDPOINT = 'confined-bundle-reader';
const BARE_ENDPOINT = 'confined-bundle-bare';

const flowIds = {} as Record<string, string>;

function admin(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);
}

async function clearItems(vendor: string) {
	const existing = await admin(
		request(getUrl(vendor))
			.get(`/items/${COLLECTION}`)
			.query({ fields: ['id'], limit: -1 })
	);

	const ids = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	if (ids.length > 0) {
		await admin(request(getUrl(vendor)).delete(`/items/${COLLECTION}`)).send(ids);
	}
}

const PROBE_FLOW = {
	status: 'active',
	trigger: 'webhook',
	accountability: 'all',
	options: { method: 'POST', async: false },
};

// Reconciles the operation probe flow and its single operation to the exact expected
// state, so a stale trigger, options, or duplicate from an earlier run is never reused
// against the persisted local database.
async function ensureOperationFlow(vendor: string): Promise<string> {
	const name = 'confined bundle operation probe';

	const existingFlows = await admin(
		request(getUrl(vendor))
			.get('/flows')
			.query({ filter: { name: { _eq: name } }, fields: ['id'], limit: -1 })
	);

	const flowIdsFound = (existingFlows.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (flowIdsFound.length > 1) {
		await admin(request(getUrl(vendor)).delete('/flows')).send(flowIdsFound.slice(1));
	}

	let flowId: string;

	if (flowIdsFound.length > 0) {
		flowId = flowIdsFound[0];
	} else {
		const created = await admin(
			request(getUrl(vendor))
				.post('/flows')
				.query({ fields: ['id'] })
		).send({ name, ...PROBE_FLOW });

		flowId = created.body.data.id;
	}

	const existingOperations = await admin(
		request(getUrl(vendor))
			.get('/operations')
			.query({ filter: { flow: { _eq: flowId } }, fields: ['id'], limit: -1 })
	);

	const operationIds = (existingOperations.body.data ?? []).map((operation: { id: string }) => operation.id);

	if (operationIds.length > 1) {
		await admin(request(getUrl(vendor)).delete('/operations')).send(operationIds.slice(1));
	}

	const operation = {
		name: 'probe',
		key: 'probe',
		type: OP_TYPE,
		position_x: 1,
		position_y: 1,
		options: { probe: '{{$trigger.body.probe}}' },
	};

	let operationId: string;

	if (operationIds.length > 0) {
		operationId = operationIds[0];
		await admin(request(getUrl(vendor)).patch(`/operations/${operationId}`)).send(operation);
	} else {
		const created = await admin(
			request(getUrl(vendor))
				.post('/operations')
				.query({ fields: ['id'] })
		).send({ ...operation, flow: flowId });

		operationId = created.body.data.id;
	}

	await admin(request(getUrl(vendor)).patch(`/flows/${flowId}`)).send({ ...PROBE_FLOW, operation: operationId });

	return flowId;
}

// The flow manager reloads asynchronously on flow mutations, so poll until the bundle
// operation entry answers with its marker.
async function awaitFlowReady(vendor: string, flowId: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const response = await request(getUrl(vendor)).post(`/flows/trigger/${flowId}`).send({ probe: 'ready' });

		if (response.status === 200 && response.body !== null && response.body.marker === OP_TYPE) return;

		await sleep(100);
	}

	throw new Error(`the confined bundle operation flow ${flowId} never produced a result`);
}

describe('Confined bundle server entries through the real binding', () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			await CreateCollection(vendor, {
				collection: COLLECTION,
				fields: [
					{ field: 'title', type: 'string', meta: {}, schema: {} },
					{ field: 'stamped', type: 'string', meta: {}, schema: {} },
					{ field: 'stamped_by', type: 'string', meta: {}, schema: {} },
				],
			});

			// The database persists across local runs, so reseed from a clean slate.
			await clearItems(vendor);

			flowIds[vendor] = await ensureOperationFlow(vendor);
			await awaitFlowReady(vendor, flowIds[vendor]);
		}
	}, 180000);

	describe('fixture registration', () => {
		it.each(vendors)('%s loads every server entry from the one bundle artifact', async (vendor) => {
			const response = await admin(request(getUrl(vendor)).get('/extensions')).expect(200);

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
		it.each(vendors)(
			'%s grants items to the declaring endpoint and denies its sibling from the same artifact',
			async (vendor) => {
				const created = await admin(request(getUrl(vendor)).post(`/items/${COLLECTION}`)).send({
					title: `isolation-${vendor}`,
				});

				expect(created.status).toBe(200);

				// The reader entry declared the items capability, so its read succeeds.
				const reader = await admin(request(getUrl(vendor)).post(`/${READER_ENDPOINT}/read`)).send({
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
				const bare = await admin(request(getUrl(vendor)).post(`/${BARE_ENDPOINT}/read`)).send({
					collection: COLLECTION,
					query: { fields: ['title'], limit: 10 },
				});

				expect(bare.status).toBe(200);
				expect(bare.body.ok).toBe(false);
				expect(bare.body.error.code).toBe('denied');
			},
			60000
		);
	});

	describe('hook entry transforms through a real child', () => {
		it.each(vendors)(
			'%s stamps a created item through the bundle hook entry',
			async (vendor) => {
				const title = `hooked-${vendor}`;

				const created = await admin(request(getUrl(vendor)).post(`/items/${COLLECTION}`)).send({ title });

				expect(created.status).toBe(200);

				const stored = await admin(
					request(getUrl(vendor))
						.get(`/items/${COLLECTION}/${created.body.data.id}`)
						.query({ fields: ['title', 'stamped', 'stamped_by'] })
				);

				expect(stored.status).toBe(200);
				expect(stored.body.data.title).toBe(title);
				expect(stored.body.data.stamped).toBe('by-confined-bundle-hook');

				// The event accountability reached the guest: the stamp carries the caller.
				expect(typeof stored.body.data.stamped_by).toBe('string');
				expect(stored.body.data.stamped_by.length).toBeGreaterThan(0);
			},
			60000
		);
	});

	describe('operation entry runs through a real child', () => {
		it.each(vendors)(
			'%s runs the bundle operation entry from the same artifact',
			async (vendor) => {
				const triggered = await request(getUrl(vendor))
					.post(`/flows/trigger/${flowIds[vendor]}`)
					.send({ probe: 'pong' });

				expect(triggered.status).toBe(200);
				expect(triggered.body).toMatchObject({ marker: OP_TYPE, received: 'pong' });
			},
			60000
		);
	});

	describe('operation secret options through the at-rest contract', () => {
		const SECRET_MASK = '**********';
		const PLAINTEXT = 'sk_live_blackbox_flow_secret';
		const databases = new Map<string, Knex>();

		beforeAll(() => {
			for (const vendor of vendors) {
				databases.set(vendor, knex(config.knexConfig[vendor]!));
			}
		});

		afterAll(async () => {
			for (const [, db] of databases) {
				await db.destroy();
			}
		});

		async function operationId(vendor: string): Promise<string> {
			const found = await admin(
				request(getUrl(vendor))
					.get('/operations')
					.query({ filter: { flow: { _eq: flowIds[vendor] } }, fields: ['id'], limit: -1 })
			);

			return found.body.data[0].id;
		}

		async function storedOptions(vendor: string, id: string): Promise<Record<string, any>> {
			const row = await databases.get(vendor)!('directus_operations').where({ id }).first();
			return typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
		}

		async function triggerUntilSecretReady(vendor: string, probe: string): Promise<Record<string, any>> {
			for (let attempt = 0; attempt < 50; attempt++) {
				const response = await request(getUrl(vendor)).post(`/flows/trigger/${flowIds[vendor]}`).send({ probe });

				if (response.status === 200 && response.body?.apiKeyKind === 'secret-reference') return response.body;

				await sleep(100);
			}

			throw new Error('the operation never received its secret as a reference');
		}

		it.each(vendors)(
			'%s encrypts at rest, masks every external read, preserves on mask resave, and delivers a reference',
			async (vendor) => {
				const id = await operationId(vendor);

				const written = await admin(request(getUrl(vendor)).patch(`/operations/${id}`)).send({
					options: { probe: '{{$trigger.body.probe}}', api_key: PLAINTEXT },
				});

				expect(written.status).toBe(200);
				expect(written.body.data.options.api_key).toBe(SECRET_MASK);
				expect(JSON.stringify(written.body)).not.toContain(PLAINTEXT);

				const atRest = await storedOptions(vendor, id);
				expect(atRest.api_key.kind).toBe('cairncms-secret-envelope');
				expect(JSON.stringify(atRest)).not.toContain(PLAINTEXT);

				const read = await admin(
					request(getUrl(vendor))
						.get(`/operations/${id}`)
						.query({ fields: ['type', 'options'] })
				);

				expect(read.status).toBe(200);
				expect(read.body.data.options.api_key).toBe(SECRET_MASK);
				expect(read.body.data.options.probe).toBe('{{$trigger.body.probe}}');
				expect(JSON.stringify(read.body)).not.toContain(PLAINTEXT);

				const nested = await admin(
					request(getUrl(vendor))
						.get(`/flows/${flowIds[vendor]}`)
						.query({ fields: ['*', 'operations.*'] })
				);

				expect(nested.status).toBe(200);

				const nestedOperation = nested.body.data.operations.find((operation: { id: string }) => operation.id === id);
				expect(nestedOperation.options.api_key).toBe(SECRET_MASK);
				expect(JSON.stringify(nested.body)).not.toContain(PLAINTEXT);

				const patchRevision = await admin(
					request(getUrl(vendor))
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

				const resaved = await admin(request(getUrl(vendor)).patch(`/operations/${id}`)).send({
					options: { probe: '{{$trigger.body.probe}}', api_key: SECRET_MASK },
				});

				expect(resaved.status).toBe(200);

				const preserved = await storedOptions(vendor, id);
				expect(preserved.api_key.ct).toBe(atRest.api_key.ct);

				const outcome = await triggerUntilSecretReady(vendor, 'secret-run');
				expect(outcome).toMatchObject({ marker: OP_TYPE, received: 'secret-run', apiKeyKind: 'secret-reference' });
				expect(JSON.stringify(outcome)).not.toContain(PLAINTEXT);

				const runRevision = await admin(
					request(getUrl(vendor))
						.get('/revisions')
						.query({
							filter: { collection: { _eq: 'directus_flows' }, item: { _eq: flowIds[vendor] } },
							sort: '-id',
							limit: 1,
						})
				);

				expect(runRevision.status).toBe(200);
				expect(runRevision.body.data.length).toBe(1);
				expect(JSON.stringify(runRevision.body)).not.toContain(PLAINTEXT);
			},
			120000
		);

		it.each(vendors)(
			'%s rejects a mask write with no stored secret behind it',
			async (vendor) => {
				const id = await operationId(vendor);

				const cleared = await admin(request(getUrl(vendor)).patch(`/operations/${id}`)).send({
					options: { probe: '{{$trigger.body.probe}}', api_key: '' },
				});

				expect(cleared.status).toBe(200);

				const masked = await admin(request(getUrl(vendor)).patch(`/operations/${id}`)).send({
					options: { probe: '{{$trigger.body.probe}}', api_key: SECRET_MASK },
				});

				expect(masked.status).toBe(400);
			},
			60000
		);
	});
});
