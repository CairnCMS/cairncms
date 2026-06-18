import { getUrl } from '@common/config';
import { CreateCollection } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
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
});
