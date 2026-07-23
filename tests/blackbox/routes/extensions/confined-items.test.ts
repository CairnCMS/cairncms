import { getUrl } from '@common/config';
import { CreateCollection, CreateItem, CreateRole } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
import request from 'supertest';
import { sleep } from '@utils/sleep';

const TENANT_COLLECTION = 'confined_tenant_records';
const QUARANTINE_COLLECTION = 'confined_quarantine_records';
const CANARY_COLLECTION = 'confined_canary_events';
const CURRENT_USER_OPERATION = 'cairncms-extension-confined-items';
const SYSTEM_OPERATION = 'cairncms-extension-confined-items-system';
const CANARY_HOOK = 'cairncms-extension-items-canary';
const TENANT_A_TOKEN = 'ConfinedTenantAToken';
const TENANT_B_TOKEN = 'ConfinedTenantBToken';

const TENANT_FIELDS = [
	{ field: 'tenant_id', type: 'string' },
	{ field: 'title', type: 'string' },
	{ field: 'public_body', type: 'string' },
	{ field: 'private_note', type: 'string' },
];

// Every probe option resolves from the trigger body, so one flow per fixture serves
// every assertion. A single-tag template passes the raw value through, objects included.
const PROBE_OPTIONS = {
	action: '{{$trigger.body.action}}',
	collection: '{{$trigger.body.collection}}',
	key: '{{$trigger.body.key}}',
	query: '{{$trigger.body.query}}',
};

const rowIds = {} as Record<string, { a: number; b: number; quarantined: number }>;
const flowIds = {} as Record<string, { currentUser: string; system: string }>;

type HostReply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

function admin(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);
}

async function clearItems(vendor: string, collection: string) {
	const existing = await admin(
		request(getUrl(vendor))
			.get(`/items/${collection}`)
			.query({ fields: ['id'], limit: -1 })
	);

	const ids = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	if (ids.length > 0) {
		await admin(request(getUrl(vendor)).delete(`/items/${collection}`)).send(ids);
	}
}

async function ensureFields(vendor: string, collection: string, fields: { field: string; type: string }[]) {
	const existing = await admin(request(getUrl(vendor)).get(`/fields/${collection}`));
	const present = new Set((existing.body.data ?? []).map((entry: { field: string }) => entry.field));

	for (const field of fields) {
		if (present.has(field.field)) continue;
		await admin(request(getUrl(vendor)).post(`/fields/${collection}`)).send({ ...field, meta: {}, schema: {} });
	}
}

async function ensureReadPermission(vendor: string, role: string, tenant: string) {
	const expected = {
		role,
		collection: TENANT_COLLECTION,
		action: 'read',
		permissions: { tenant_id: { _eq: tenant } },
		fields: ['id', 'tenant_id', 'title', 'public_body'],
	};

	const existing = await admin(
		request(getUrl(vendor))
			.get('/permissions')
			.query({
				filter: { role: { _eq: role }, collection: { _eq: TENANT_COLLECTION }, action: { _eq: 'read' } },
				fields: ['id'],
			})
	);

	const found = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	if (found.length === 0) {
		await admin(request(getUrl(vendor)).post('/permissions')).send(expected);
		return;
	}

	// Reconcile a stale row to the expected shape, and remove duplicates, which would
	// otherwise OR-merge into a wider grant.
	await admin(request(getUrl(vendor)).patch(`/permissions/${found[0]}`)).send(expected);

	if (found.length > 1) {
		await admin(request(getUrl(vendor)).delete('/permissions')).send(found.slice(1));
	}
}

async function ensureUser(vendor: string, email: string, role: string, token: string) {
	const existing = await admin(
		request(getUrl(vendor))
			.get('/users')
			.query({ filter: { email: { _eq: email } }, fields: ['id'] })
	);

	const found = existing.body.data ?? [];

	if (found.length > 0) {
		await admin(request(getUrl(vendor)).patch(`/users/${found[0].id}`)).send({ role, token });
		return;
	}

	await admin(request(getUrl(vendor)).post('/users')).send({ email, role, token });
}

const PROBE_FLOW = {
	status: 'active',
	trigger: 'webhook',
	accountability: 'all',
	options: { method: 'POST', async: false },
};

// Reconciles the named probe flow and its operation row to the exact expected state,
// so stale trigger settings, options, status, or duplicates from an earlier failed
// run can never be reused.
async function ensureProbeFlow(vendor: string, name: string, type: string): Promise<string> {
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
		).send({
			name,
			...PROBE_FLOW,
		});

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

	const operation = { name: 'probe', key: 'probe', type, position_x: 1, position_y: 1, options: PROBE_OPTIONS };

	let operationId: string;

	if (operationIds.length > 0) {
		operationId = operationIds[0];
		await admin(request(getUrl(vendor)).patch(`/operations/${operationId}`)).send(operation);
	} else {
		const created = await admin(
			request(getUrl(vendor))
				.post('/operations')
				.query({ fields: ['id'] })
		).send({
			...operation,
			flow: flowId,
		});

		operationId = created.body.data.id;
	}

	await admin(request(getUrl(vendor)).patch(`/flows/${flowId}`)).send({ ...PROBE_FLOW, operation: operationId });

	return flowId;
}

// The flow manager reloads asynchronously on flow mutations, so poll until the flow
// is registered and its operation produces a host reply.
async function awaitFlowReady(vendor: string, flowId: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const response = await request(getUrl(vendor))
			.post(`/flows/trigger/${flowId}`)
			.send({ action: 'read', collection: TENANT_COLLECTION, key: 0, query: {} });

		if (response.status === 200 && response.body !== null && typeof response.body.ok === 'boolean') return;

		await sleep(100);
	}

	throw new Error(`the confined operation flow ${flowId} never produced a host reply`);
}

async function deleteLegacyProbeFlows(vendor: string) {
	const stale = await admin(
		request(getUrl(vendor))
			.get('/flows')
			.query({ filter: { name: { _starts_with: 'confined items probe ' } }, fields: ['id'], limit: -1 })
	);

	const ids = (stale.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (ids.length > 0) {
		await admin(request(getUrl(vendor)).delete('/flows')).send(ids);
	}
}

async function runOperation(
	vendor: string,
	flow: 'currentUser' | 'system',
	body: Record<string, unknown>,
	token?: string
): Promise<HostReply> {
	const trigger = request(getUrl(vendor)).post(`/flows/trigger/${flowIds[vendor]![flow]}`);
	if (token) trigger.set('Authorization', `Bearer ${token}`);

	const response = await trigger.send({ action: 'read', key: 0, query: {}, ...body });

	if (response.status !== 200 || response.body === null || typeof response.body.ok !== 'boolean') {
		throw new Error(`the confined operation trigger answered ${response.status} without a host reply`);
	}

	return response.body;
}

async function readCanaryEvents(vendor: string): Promise<string[]> {
	const fired = await admin(
		request(getUrl(vendor))
			.get(`/items/${CANARY_COLLECTION}`)
			.query({ fields: ['event'], limit: -1 })
	);

	return (fired.body.data ?? []).map((row: { event: string }) => row.event);
}

describe('Confined items host through the real flow binding', () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			// The canary collection comes first so the canary hook can record from the
			// moment the tenant collection exists.
			await CreateCollection(vendor, {
				collection: CANARY_COLLECTION,
				fields: [{ field: 'event', type: 'string', meta: {}, schema: {} }],
			});

			await CreateCollection(vendor, {
				collection: TENANT_COLLECTION,
				fields: TENANT_FIELDS.map((field) => ({ ...field, meta: {}, schema: {} })),
			});

			await CreateCollection(vendor, {
				collection: QUARANTINE_COLLECTION,
				fields: [{ field: 'note', type: 'string', meta: {}, schema: {} }],
			});

			await ensureFields(vendor, TENANT_COLLECTION, TENANT_FIELDS);

			const roleA = await CreateRole(vendor, {
				name: 'Confined Tenant A',
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			const roleB = await CreateRole(vendor, {
				name: 'Confined Tenant B',
				appAccessEnabled: false,
				adminAccessEnabled: false,
			});

			await ensureReadPermission(vendor, roleA.id, 'A');
			await ensureReadPermission(vendor, roleB.id, 'B');

			await ensureUser(vendor, 'confined-tenant-a@example.com', roleA.id, TENANT_A_TOKEN);
			await ensureUser(vendor, 'confined-tenant-b@example.com', roleB.id, TENANT_B_TOKEN);

			await deleteLegacyProbeFlows(vendor);

			// The database persists across local runs, so reseed from a clean slate.
			await clearItems(vendor, TENANT_COLLECTION);
			await clearItems(vendor, QUARANTINE_COLLECTION);

			const rowA = await CreateItem(vendor, {
				collection: TENANT_COLLECTION,
				item: {
					tenant_id: 'A',
					title: 'Alpha record',
					public_body: 'alpha public body',
					private_note: 'alpha secret note',
				},
			});

			const rowB = await CreateItem(vendor, {
				collection: TENANT_COLLECTION,
				item: {
					tenant_id: 'B',
					title: 'Beta record',
					public_body: 'beta public body',
					private_note: 'beta secret note',
				},
			});

			const quarantined = await CreateItem(vendor, {
				collection: QUARANTINE_COLLECTION,
				item: { note: 'quarantined' },
			});

			rowIds[vendor] = { a: rowA.id, b: rowB.id, quarantined: quarantined.id };

			const currentUser = await ensureProbeFlow(
				vendor,
				'confined items host probe (current-user)',
				CURRENT_USER_OPERATION
			);

			const system = await ensureProbeFlow(vendor, 'confined items host probe (system)', SYSTEM_OPERATION);

			flowIds[vendor] = { currentUser, system };

			await awaitFlowReady(vendor, currentUser);
			await awaitFlowReady(vendor, system);

			await clearItems(vendor, CANARY_COLLECTION);
		}
	}, 180000);

	describe('fixture registration', () => {
		it.each(vendors)('%s loads the confined items fixtures and the canary through the real loader', async (vendor) => {
			const response = await admin(request(getUrl(vendor)).get('/extensions')).expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			expect(byName[CURRENT_USER_OPERATION]?.status).toBe('loaded');
			expect(byName[SYSTEM_OPERATION]?.status).toBe('loaded');
			expect(byName[CANARY_HOOK]?.status).toBe('loaded');
		});
	});

	describe('tenant row isolation', () => {
		it.each(vendors)(
			'%s returns each tenant only its own rows and never the hidden field',
			async (vendor) => {
				const replyA = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { fields: ['*'] } },
					TENANT_A_TOKEN
				);

				expect(replyA.ok).toBe(true);
				const rowsA = (replyA as { value: Record<string, unknown>[] }).value;
				expect(rowsA).toHaveLength(1);
				expect(rowsA[0]?.['title']).toBe('Alpha record');
				expect(rowsA[0]).not.toHaveProperty('private_note');
				expect(JSON.stringify(replyA)).not.toContain('secret note');

				const replyB = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { fields: ['*'] } },
					TENANT_B_TOKEN
				);

				expect(replyB.ok).toBe(true);
				const rowsB = (replyB as { value: Record<string, unknown>[] }).value;
				expect(rowsB).toHaveLength(1);
				expect(rowsB[0]?.['title']).toBe('Beta record');
				expect(rowsB[0]).not.toHaveProperty('private_note');
			},
			60000
		);
	});

	describe('hidden fields are not an oracle', () => {
		it.each(vendors)(
			'%s answers a hidden field and a nonexistent field identically on select',
			async (vendor) => {
				const hidden = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { fields: ['private_note'] } },
					TENANT_A_TOKEN
				);

				const missing = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { fields: ['no_such_field'] } },
					TENANT_A_TOKEN
				);

				expect(hidden.ok).toBe(false);
				expect(missing).toEqual(hidden);
			},
			60000
		);

		it.each(vendors)(
			'%s answers a hidden field and a nonexistent field identically on filter',
			async (vendor) => {
				const hidden = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { filter: { private_note: { _eq: 'alpha secret note' } } } },
					TENANT_A_TOKEN
				);

				const missing = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { filter: { no_such_field: { _eq: 'alpha secret note' } } } },
					TENANT_A_TOKEN
				);

				expect(hidden.ok).toBe(false);
				expect(JSON.stringify(hidden)).not.toContain('secret note');
				expect(missing).toEqual(hidden);
			},
			60000
		);

		it.each(vendors)(
			'%s answers a hidden field and a nonexistent field identically on sort',
			async (vendor) => {
				const hidden = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { sort: ['private_note'] } },
					TENANT_A_TOKEN
				);

				const missing = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { sort: ['no_such_field'] } },
					TENANT_A_TOKEN
				);

				expect(hidden.ok).toBe(false);
				expect(missing).toEqual(hidden);
			},
			60000
		);

		it.each(vendors)(
			'%s does not match hidden field content through search',
			async (vendor) => {
				const secret = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { search: 'secret note' } },
					TENANT_A_TOKEN
				);

				expect(secret.ok).toBe(true);
				expect((secret as { value: unknown[] }).value).toHaveLength(0);

				const visible = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { search: 'public body' } },
					TENANT_A_TOKEN
				);

				expect(visible.ok).toBe(true);
				const rows = (visible as { value: Record<string, unknown>[] }).value;
				expect(rows).toHaveLength(1);
				expect(rows[0]?.['title']).toBe('Alpha record');
			},
			60000
		);
	});

	describe('readOne forbidden and missing collapse', () => {
		it.each(vendors)(
			"%s answers another tenant's row and a missing row identically",
			async (vendor) => {
				const forbidden = await runOperation(
					vendor,
					'currentUser',
					{ action: 'readOne', collection: TENANT_COLLECTION, key: rowIds[vendor]!.b },
					TENANT_A_TOKEN
				);

				const missing = await runOperation(
					vendor,
					'currentUser',
					{ action: 'readOne', collection: TENANT_COLLECTION, key: 999999 },
					TENANT_A_TOKEN
				);

				expect(forbidden).toEqual({ ok: true, value: null });
				expect(missing).toEqual({ ok: true, value: null });
			},
			60000
		);
	});

	describe('collection visibility is not an oracle', () => {
		it.each(vendors)(
			'%s answers a denied collection and a nonexistent collection identically',
			async (vendor) => {
				const denied = await runOperation(vendor, 'currentUser', { collection: QUARANTINE_COLLECTION }, TENANT_A_TOKEN);

				const missing = await runOperation(vendor, 'currentUser', { collection: 'no_such_collection' }, TENANT_A_TOKEN);

				expect(denied.ok).toBe(false);
				expect(missing).toEqual(denied);

				const deniedOne = await runOperation(
					vendor,
					'currentUser',
					{ action: 'readOne', collection: QUARANTINE_COLLECTION, key: rowIds[vendor]!.quarantined },
					TENANT_A_TOKEN
				);

				const missingOne = await runOperation(
					vendor,
					'currentUser',
					{ action: 'readOne', collection: 'no_such_collection', key: 1 },
					TENANT_A_TOKEN
				);

				expect(deniedOne).toEqual({ ok: true, value: null });
				expect(missingOne).toEqual(deniedOne);
			},
			60000
		);
	});

	describe('top-level system collections are refused', () => {
		it.each(vendors)(
			'%s refuses a top-level directus_* system collection under full-access, identically to a nonexistent collection',
			async (vendor) => {
				const refused = await runOperation(vendor, 'system', { collection: 'directus_users' });

				const missing = await runOperation(vendor, 'system', { collection: 'no_such_collection' });

				expect(refused).toMatchObject({ ok: false, error: { code: 'denied' } });
				expect(missing).toEqual(refused);
			},
			60000
		);

		it.each(vendors)(
			'%s collapses a top-level directus_* readOne of a real user to null under full-access',
			async (vendor) => {
				const refused = await runOperation(vendor, 'system', {
					action: 'readOne',
					collection: 'directus_users',
					key: USER.TESTS_FLOW.ID,
				});

				expect(refused).toEqual({ ok: true, value: null });
			},
			60000
		);
	});

	describe('caller authority', () => {
		it.each(vendors)(
			'%s reads as public for an unauthenticated caller and is denied without a public grant',
			async (vendor) => {
				const reply = await runOperation(vendor, 'currentUser', { collection: TENANT_COLLECTION });

				expect(reply.ok).toBe(false);
				expect(JSON.stringify(reply)).not.toContain('secret note');
			},
			60000
		);

		it.each(vendors)(
			'%s elevates only because the manifest declared system, not because of the caller',
			async (vendor) => {
				const reply = await runOperation(vendor, 'system', {
					collection: TENANT_COLLECTION,
					query: { fields: ['*'], sort: ['id'] },
				});

				expect(reply.ok).toBe(true);
				const rows = (reply as { value: Record<string, unknown>[] }).value;
				expect(rows).toHaveLength(2);
				expect(rows[0]?.['private_note']).toBe('alpha secret note');
				expect(rows[1]?.['private_note']).toBe('beta secret note');
			},
			60000
		);
	});

	describe('broker query bounds through the real path', () => {
		it.each(vendors)(
			'%s refuses an unsupported query feature before the service runs',
			async (vendor) => {
				const reply = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { deep: { related: { _limit: 1 } } } },
					TENANT_A_TOKEN
				);

				expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
			},
			60000
		);

		it.each(vendors)(
			'%s refuses a malformed limit and accepts an over-cap limit clamped',
			async (vendor) => {
				const malformed = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { limit: 0 } },
					TENANT_A_TOKEN
				);

				expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

				// An over-cap limit is clamped to the broker maximum, not refused.
				const clamped = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { limit: 101 } },
					TENANT_A_TOKEN
				);

				expect(clamped.ok).toBe(true);
			},
			60000
		);
	});

	describe('brokered reads do not fire item events', () => {
		it.each(vendors)(
			'%s records platform read events but none for a brokered read',
			async (vendor) => {
				await clearItems(vendor, CANARY_COLLECTION);

				// Positive control: a platform REST read fires the canary hook, proving
				// the canary observes this collection's events. The read action emission
				// is not awaited by the read path, so poll briefly.
				const controlStarted = Date.now();

				await admin(request(getUrl(vendor)).get(`/items/${TENANT_COLLECTION}`)).expect(200);

				let events: string[] = [];

				for (let attempt = 0; attempt < 50; attempt++) {
					events = await readCanaryEvents(vendor);
					if (events.includes('query') && events.includes('read')) break;
					await sleep(100);
				}

				expect(events).toContain('query');
				expect(events).toContain('read');

				const observedLatency = Date.now() - controlStarted;

				await clearItems(vendor, CANARY_COLLECTION);

				const reply = await runOperation(
					vendor,
					'currentUser',
					{ collection: TENANT_COLLECTION, query: { fields: ['*'] } },
					TENANT_A_TOKEN
				);

				expect(reply.ok).toBe(true);

				// Absence cannot be polled for, so settle for a multiple of the emission
				// latency the positive control just measured, bounded by the test timeout.
				await sleep(Math.min(observedLatency * 3 + 1000, 15000));

				expect(await readCanaryEvents(vendor)).toEqual([]);
			},
			60000
		);
	});

	describe('host.items cannot reach an internal table', () => {
		it.each(vendors)(
			'%s answers a request for cairncms_extension_settings with a host error',
			async (vendor) => {
				const reply = await runOperation(
					vendor,
					'currentUser',
					{ collection: 'cairncms_extension_settings' },
					TENANT_A_TOKEN
				);

				expect(reply.ok).toBe(false);
			},
			60000
		);
	});
});
