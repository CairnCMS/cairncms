import config, { getUrl } from '@common/config';
import { CreateCollection, CreateFieldM2O, CreateFieldO2M, CreateItem, CreateRole } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
import knex, { type Knex } from 'knex';
import { isEqual } from 'lodash';
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
const APP_TENANT_TOKEN = 'ConfinedAppTenantToken';
const CHILD_COLLECTION = 'confined_tenant_children';
const VALIDATION_COLLECTION = 'confined_validation_records';
const ACTION_FLOW_NAME = 'confined items host action parity';

const TENANT_FIELDS = [
	{ field: 'tenant_id', type: 'string' },
	{ field: 'title', type: 'string' },
	{ field: 'public_body', type: 'string' },
	{ field: 'private_note', type: 'string' },
	{ field: 'probe_tag', type: 'string' },
];

const CHILD_FIELDS = [
	{ field: 'label', type: 'string' },
	{ field: 'probe_tag', type: 'string' },
];

// Every probe option resolves from the trigger body, so one flow per fixture serves
// every assertion. A single-tag template passes the raw value through, objects included.
const PROBE_OPTIONS = {
	action: '{{$trigger.body.action}}',
	collection: '{{$trigger.body.collection}}',
	key: '{{$trigger.body.key}}',
	query: '{{$trigger.body.query}}',
	payload: '{{$trigger.body.payload}}',
	payloads: '{{$trigger.body.payloads}}',
	keys: '{{$trigger.body.keys}}',
};

const rowIds = {} as Record<string, { a: number; b: number; quarantined: number }>;
const flowIds = {} as Record<string, { currentUser: string; system: string }>;
const databases = new Map<string, Knex>();

type HostReply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

function admin(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);
}

async function clearItems(vendor: string, collection: string) {
	const existing = expectOk(
		await admin(
			request(getUrl(vendor))
				.get(`/items/${collection}`)
				.query({ fields: ['id'], limit: -1 })
		),
		`read items ${collection}`
	);

	const ids = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	// Deleted in batches, because a reset after a run that filled a relational graph can
	// exceed the operator mutation limit that applies to this request too.
	const batch = Number(config.envs[vendor]!.MAX_BATCH_MUTATION);

	for (let index = 0; index < ids.length; index += batch) {
		expectOk(
			await admin(request(getUrl(vendor)).delete(`/items/${collection}`)).send(ids.slice(index, index + batch)),
			`clear items ${collection}`
		);
	}
}

async function ensureFields(vendor: string, collection: string, fields: { field: string; type: string }[]) {
	const existing = expectOk(
		await admin(request(getUrl(vendor)).get(`/fields/${collection}`)),
		`read fields ${collection}`
	);

	const present = new Set((existing.body.data ?? []).map((entry: { field: string }) => entry.field));

	for (const field of fields) {
		if (present.has(field.field)) continue;

		expectOk(
			await admin(request(getUrl(vendor)).post(`/fields/${collection}`)).send({ ...field, meta: {}, schema: {} }),
			`create field ${collection}.${field.field}`
		);
	}

	const settled = expectOk(
		await admin(request(getUrl(vendor)).get(`/fields/${collection}`)),
		`read fields ${collection}`
	);

	const settledFields = new Map(
		(settled.body.data ?? []).map((entry: { field: string; type: string }) => [entry.field, entry.type])
	);

	for (const field of fields) {
		const settledType = settledFields.get(field.field);

		if (settledType !== field.type) {
			throw new Error(`field ${collection}.${field.field} is ${String(settledType)}, expected ${field.type}`);
		}
	}
}

function expectOk(res: request.Response, label: string): request.Response {
	if (res.status >= 300) {
		throw new Error(`${label} failed with ${res.status}: ${JSON.stringify(res.body)}`);
	}

	return res;
}

type FieldShape = { type: string; meta: { special?: string[] | null } | null };

type RelationShape = {
	related_collection: string | null;
	meta: { one_field?: string | null } | null;
	schema: { foreign_key_table?: string | null } | null;
};

async function getField(vendor: string, collection: string, field: string): Promise<FieldShape | null> {
	const res = expectOk(await admin(request(getUrl(vendor)).get(`/fields/${collection}`)), `read fields ${collection}`);
	return (res.body.data ?? []).find((entry: { field: string }) => entry.field === field) ?? null;
}

async function fieldExists(vendor: string, collection: string, field: string): Promise<boolean> {
	return (await getField(vendor, collection, field)) !== null;
}

async function deleteFieldIfExists(vendor: string, collection: string, field: string) {
	if (await fieldExists(vendor, collection, field)) {
		expectOk(await admin(request(getUrl(vendor)).delete(`/fields/${collection}/${field}`)), `delete ${collection}.${field}`);
	}
}

async function getRelation(vendor: string, collection: string, field: string): Promise<RelationShape | null> {
	const res = await admin(request(getUrl(vendor)).get(`/relations/${collection}/${field}`));
	// The relation endpoint conceals missing relations as forbidden.
	if (res.status === 404 || res.status === 403) return null;
	expectOk(res, `read relation ${collection}.${field}`);
	return res.body.data ?? null;
}

async function m2oCorrect(vendor: string, collection: string, field: string, related: string): Promise<boolean> {
	const relation = await getRelation(vendor, collection, field);
	const shape = await getField(vendor, collection, field);

	return (
		relation?.related_collection === related &&
		relation.schema?.foreign_key_table === related &&
		(shape?.meta?.special ?? []).includes('m2o')
	);
}

async function ensureM2O(vendor: string, collection: string, field: string, related: string, pkType: 'uuid' | 'integer') {
	if (await m2oCorrect(vendor, collection, field, related)) return;

	await deleteFieldIfExists(vendor, collection, field);
	await CreateFieldM2O(vendor, { collection, field, otherCollection: related, primaryKeyType: pkType });

	if (!(await m2oCorrect(vendor, collection, field, related))) {
		throw new Error(`m2o ${collection}.${field} -> ${related} not established`);
	}
}

async function o2mCorrect(
	vendor: string,
	collection: string,
	alias: string,
	childCollection: string,
	childField: string
): Promise<boolean> {
	const relation = await getRelation(vendor, childCollection, childField);
	const aliasField = await getField(vendor, collection, alias);

	return (
		relation?.related_collection === collection &&
		relation?.meta?.one_field === alias &&
		aliasField?.type === 'alias' &&
		(aliasField?.meta?.special ?? []).includes('o2m')
	);
}

async function ensureO2M(vendor: string, collection: string, alias: string, childCollection: string, childField: string) {
	if (await o2mCorrect(vendor, collection, alias, childCollection, childField)) return;

	await deleteFieldIfExists(vendor, childCollection, childField);
	await deleteFieldIfExists(vendor, collection, alias);
	await CreateFieldO2M(vendor, { collection, field: alias, otherCollection: childCollection, otherField: childField });

	if (!(await o2mCorrect(vendor, collection, alias, childCollection, childField))) {
		throw new Error(`o2m ${collection}.${alias} <- ${childCollection}.${childField} not established`);
	}
}

async function ensureCollectionAccountability(vendor: string, collection: string, value: 'all' | 'activity' | null) {
	expectOk(
		await admin(request(getUrl(vendor)).patch(`/collections/${collection}`)).send({ meta: { accountability: value } }),
		`accountability ${collection}`
	);
}

type PermissionSpec = {
	role: string;
	collection: string;
	action: string;
	permissions?: Record<string, unknown>;
	validation?: Record<string, unknown> | null;
	fields?: string[];
	presets?: Record<string, unknown>;
};

// Reconciles one permission row to the exact expected shape, and removes duplicates,
// which would otherwise OR-merge into a wider grant.
async function ensurePermission(vendor: string, spec: PermissionSpec) {
	const expected = {
		role: spec.role,
		collection: spec.collection,
		action: spec.action,
		permissions: spec.permissions ?? {},
		validation: spec.validation === undefined ? {} : spec.validation,
		fields: spec.fields ?? ['*'],
		presets: spec.presets ?? {},
	};

	const existing = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/permissions')
				.query({
					filter: {
						role: { _eq: spec.role },
						collection: { _eq: spec.collection },
						action: { _eq: spec.action },
					},
					fields: ['id'],
				})
		),
		`read permissions ${spec.collection}.${spec.action}`
	);

	const found = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	if (found.length === 0) {
		expectOk(
			await admin(request(getUrl(vendor)).post('/permissions')).send(expected),
			`create permission ${spec.collection}.${spec.action}`
		);

		return;
	}

	expectOk(
		await admin(request(getUrl(vendor)).patch(`/permissions/${found[0]}`)).send(expected),
		`patch permission ${spec.collection}.${spec.action}`
	);

	if (found.length > 1) {
		expectOk(
			await admin(request(getUrl(vendor)).delete('/permissions')).send(found.slice(1)),
			`dedupe permission ${spec.collection}.${spec.action}`
		);
	}
}

async function ensureNoPermission(vendor: string, role: string | null, collection: string, action: string) {
	const existing = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/permissions')
				.query({
					filter: {
						role: role === null ? { _null: true } : { _eq: role },
						collection: { _eq: collection },
						action: { _eq: action },
					},
					fields: ['id'],
				})
		),
		`read permissions ${collection}.${action}`
	);

	const found = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	if (found.length > 0) {
		expectOk(
			await admin(request(getUrl(vendor)).delete('/permissions')).send(found),
			`delete permissions ${collection}.${action}`
		);
	}
}

async function ensureReadPermission(vendor: string, role: string, tenant: string) {
	await ensurePermission(vendor, {
		role,
		collection: TENANT_COLLECTION,
		action: 'read',
		permissions: { tenant_id: { _eq: tenant } },
		fields: ['id', 'tenant_id', 'title', 'public_body'],
	});
}

async function ensureRole(vendor: string, name: string, appAccess: boolean) {
	const role = await CreateRole(vendor, { name, appAccessEnabled: appAccess, adminAccessEnabled: false });

	expectOk(
		await admin(request(getUrl(vendor)).patch(`/roles/${role.id}`)).send({ app_access: appAccess, admin_access: false }),
		`role ${name} flags`
	);

	return role;
}

async function ensureUser(vendor: string, email: string, role: string, token: string) {
	const existing = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/users')
				.query({ filter: { email: { _eq: email } }, fields: ['id'] })
		),
		`read user ${email}`
	);

	const found = existing.body.data ?? [];

	if (found.length > 0) {
		expectOk(
			await admin(request(getUrl(vendor)).patch(`/users/${found[0].id}`)).send({ role, token }),
			`patch user ${email}`
		);
	} else {
		expectOk(await admin(request(getUrl(vendor)).post('/users')).send({ email, role, token }), `create user ${email}`);
	}

	const settled = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/users')
				.query({ filter: { email: { _eq: email } }, fields: ['id', 'role'] })
		),
		`read user ${email}`
	);

	const rows = settled.body.data ?? [];

	if (rows.length !== 1 || rows[0].role !== role) {
		throw new Error(`user ${email} did not reconcile to the expected role`);
	}

	// The token field is concealed on read, so authenticate with it instead of comparing
	// it. A caller without read permission on directus_users gets an id-only payload from
	// this endpoint, so identity is the only field it can assert.
	const authenticated = expectOk(
		await request(getUrl(vendor)).get('/users/me').query({ fields: ['id'] }).set('Authorization', `Bearer ${token}`),
		`authenticate user ${email}`
	);

	if (authenticated.body.data?.id !== rows[0].id) {
		throw new Error(`the token for ${email} authenticated as ${JSON.stringify(authenticated.body.data)}`);
	}
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
	const existingFlows = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/flows')
				.query({ filter: { name: { _eq: name } }, fields: ['id'], limit: -1 })
		),
		`read flows ${name}`
	);

	const flowIdsFound = (existingFlows.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (flowIdsFound.length > 1) {
		expectOk(await admin(request(getUrl(vendor)).delete('/flows')).send(flowIdsFound.slice(1)), `dedupe flows ${name}`);
	}

	let flowId: string;

	if (flowIdsFound.length > 0) {
		flowId = flowIdsFound[0];
	} else {
		const created = expectOk(
			await admin(
				request(getUrl(vendor))
					.post('/flows')
					.query({ fields: ['id'] })
			).send({
				name,
				...PROBE_FLOW,
			}),
			`create flow ${name}`
		);

		flowId = created.body.data?.id;
		if (!flowId) throw new Error(`create flow ${name} returned no id`);
	}

	const existingOperations = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/operations')
				.query({ filter: { flow: { _eq: flowId } }, fields: ['id'], limit: -1 })
		),
		`read operations ${name}`
	);

	const operationIds = (existingOperations.body.data ?? []).map((operation: { id: string }) => operation.id);

	if (operationIds.length > 1) {
		expectOk(
			await admin(request(getUrl(vendor)).delete('/operations')).send(operationIds.slice(1)),
			`dedupe operations ${name}`
		);
	}

	const operation = { name: 'probe', key: 'probe', type, position_x: 1, position_y: 1, options: PROBE_OPTIONS };

	let operationId: string;

	if (operationIds.length > 0) {
		operationId = operationIds[0];

		expectOk(
			await admin(request(getUrl(vendor)).patch(`/operations/${operationId}`)).send(operation),
			`patch operation ${name}`
		);
	} else {
		const created = expectOk(
			await admin(
				request(getUrl(vendor))
					.post('/operations')
					.query({ fields: ['id'] })
			).send({
				...operation,
				flow: flowId,
			}),
			`create operation ${name}`
		);

		operationId = created.body.data?.id;
		if (!operationId) throw new Error(`create operation ${name} returned no id`);
	}

	expectOk(
		await admin(request(getUrl(vendor)).patch(`/flows/${flowId}`)).send({ ...PROBE_FLOW, operation: operationId }),
		`link operation ${name}`
	);

	const settled = expectOk(
		await admin(
			request(getUrl(vendor))
				.get(`/flows/${flowId}`)
				.query({ fields: ['status', 'trigger', 'accountability', 'options', 'operation'] })
		),
		`read flow ${name}`
	);

	const flow = settled.body.data ?? {};

	if (
		flow.status !== PROBE_FLOW.status ||
		flow.trigger !== PROBE_FLOW.trigger ||
		flow.accountability !== PROBE_FLOW.accountability ||
		!isEqual(flow.options, PROBE_FLOW.options) ||
		flow.operation !== operationId
	) {
		throw new Error(`flow ${name} did not reconcile: ${JSON.stringify(flow)}`);
	}

	const settledOperation = expectOk(
		await admin(
			request(getUrl(vendor))
				.get(`/operations/${operationId}`)
				.query({ fields: ['type', 'options'] })
		),
		`read operation ${name}`
	);

	const reconciled = settledOperation.body.data ?? {};

	if (reconciled.type !== type || !isEqual(reconciled.options, PROBE_OPTIONS)) {
		throw new Error(`operation ${name} did not reconcile: ${JSON.stringify(reconciled)}`);
	}

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
	const stale = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/flows')
				.query({ filter: { name: { _starts_with: 'confined items probe ' } }, fields: ['id'], limit: -1 })
		),
		'read legacy probe flows'
	);

	const ids = (stale.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (ids.length > 0) {
		expectOk(await admin(request(getUrl(vendor)).delete('/flows')).send(ids), 'delete legacy probe flows');
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
	// Asserted, because this feeds absence assertions where a failed read would
	// otherwise become an empty result and pass for the wrong reason.
	const fired = expectOk(
		await admin(
			request(getUrl(vendor))
				.get(`/items/${CANARY_COLLECTION}`)
				.query({ fields: ['event'], limit: -1 })
		),
		'read canary events'
	);

	return (fired.body.data ?? []).map((row: { event: string }) => row.event);
}

async function waitForCanaryEvent(vendor: string, marker: string): Promise<boolean> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const rows = await db(vendor)(CANARY_COLLECTION).where({ event: marker });
		if (rows.length > 0) return true;
		await sleep(100);
	}

	return false;
}

async function ensureActionFlow(vendor: string) {
	const existing = expectOk(
		await admin(
			request(getUrl(vendor))
				.get('/flows')
				.query({ filter: { name: { _eq: ACTION_FLOW_NAME } }, fields: ['id'], limit: -1 })
		),
		'read action flows'
	);

	const ids = (existing.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (ids.length > 0) {
		expectOk(await admin(request(getUrl(vendor)).delete('/flows')).send(ids), 'delete stale action flows');
	}

	const flow = expectOk(
		await admin(request(getUrl(vendor)).post('/flows')).send({
			name: ACTION_FLOW_NAME,
			status: 'active',
			trigger: 'event',
			accountability: 'all',
			options: { type: 'action', scope: ['items.create'], collections: [TENANT_COLLECTION, CHILD_COLLECTION] },
		}),
		'create action flow'
	);

	const flowId = flow.body.data.id;

	const operation = expectOk(
		await admin(request(getUrl(vendor)).post('/operations')).send({
			name: 'record',
			key: 'record',
			type: 'item-create',
			position_x: 1,
			position_y: 1,
			options: {
				collection: CANARY_COLLECTION,
				payload: { event: '{{$trigger.payload.probe_tag}}' },
				emitEvents: false,
				permissions: '$full',
			},
			flow: flowId,
		}),
		'create action operation'
	);

	expectOk(
		await admin(request(getUrl(vendor)).patch(`/flows/${flowId}`)).send({ operation: operation.body.data.id }),
		'link action operation'
	);
}

async function awaitActionFlowReady(vendor: string) {
	const keys: (number | string)[] = [];

	try {
		for (let attempt = 0; attempt < 30; attempt++) {
			const reply = await runOperation(vendor, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'PROBE', title: 'action-flow-probe', probe_tag: 'action-flow-probe' },
			});

			if (!reply.ok) throw new Error(`the action flow probe write failed: ${JSON.stringify(reply)}`);
			keys.push((reply as { value: number | string }).value);

			const rows = await db(vendor)(CANARY_COLLECTION).where({ event: 'action-flow-probe' });
			if (rows.length > 0) return;

			await sleep(200);
		}

		throw new Error('the action flow never registered its items.create listener');
	} finally {
		if (keys.length > 0) {
			await db(vendor)(TENANT_COLLECTION).whereIn('id', keys).del();
		}
	}
}

function db(vendor: string): Knex {
	return databases.get(vendor)!;
}

describe('Confined items host through the real flow binding', () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			databases.set(vendor, knex(config.knexConfig[vendor]!));

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

			await CreateCollection(vendor, {
				collection: CHILD_COLLECTION,
				meta: { accountability: null },
				fields: CHILD_FIELDS.map((field) => ({ ...field, meta: {}, schema: {} })),
			});

			await ensureFields(vendor, CHILD_COLLECTION, CHILD_FIELDS);

			await CreateCollection(vendor, {
				collection: VALIDATION_COLLECTION,
				fields: [{ field: 'amount', type: 'integer', meta: {}, schema: {} }],
			});

			await ensureCollectionAccountability(vendor, TENANT_COLLECTION, 'all');
			await ensureCollectionAccountability(vendor, QUARANTINE_COLLECTION, null);
			await ensureCollectionAccountability(vendor, CHILD_COLLECTION, null);
			await ensureCollectionAccountability(vendor, VALIDATION_COLLECTION, 'all');

			await ensureO2M(vendor, TENANT_COLLECTION, 'children', CHILD_COLLECTION, 'parent');
			await ensureM2O(vendor, TENANT_COLLECTION, 'owner', 'directus_users', 'uuid');
			await ensureM2O(vendor, TENANT_COLLECTION, 'preset', 'directus_presets', 'integer');

			const roleA = await ensureRole(vendor, 'Confined Tenant A', false);
			const roleB = await ensureRole(vendor, 'Confined Tenant B', false);

			await ensureReadPermission(vendor, roleA.id, 'A');
			await ensureReadPermission(vendor, roleB.id, 'B');

			await ensureUser(vendor, 'confined-tenant-a@example.com', roleA.id, TENANT_A_TOKEN);
			await ensureUser(vendor, 'confined-tenant-b@example.com', roleB.id, TENANT_B_TOKEN);

			const roleApp = await ensureRole(vendor, 'Confined Tenant App', true);

			await ensureUser(vendor, 'confined-tenant-app@example.com', roleApp.id, APP_TENANT_TOKEN);

			await ensurePermission(vendor, {
				role: roleA.id,
				collection: TENANT_COLLECTION,
				action: 'create',
				validation: { tenant_id: { _eq: 'A' } },
			});

			await ensurePermission(vendor, {
				role: roleA.id,
				collection: TENANT_COLLECTION,
				action: 'update',
				permissions: { tenant_id: { _eq: 'A' } },
				validation: { tenant_id: { _eq: 'A' } },
			});

			await ensurePermission(vendor, {
				role: roleA.id,
				collection: VALIDATION_COLLECTION,
				action: 'create',
				validation: { amount: { _gte: 0 } },
			});

			await ensurePermission(vendor, { role: roleApp.id, collection: TENANT_COLLECTION, action: 'create' });

			await ensurePermission(vendor, {
				role: roleApp.id,
				collection: 'directus_presets',
				action: 'create',
				validation: null,
			});

			await ensureNoPermission(vendor, roleB.id, TENANT_COLLECTION, 'create');
			await ensureNoPermission(vendor, null, TENANT_COLLECTION, 'create');
			await ensureNoPermission(vendor, roleA.id, CHILD_COLLECTION, 'create');

			await deleteLegacyProbeFlows(vendor);

			// The database persists across local runs, so reseed from a clean slate.
			await clearItems(vendor, CHILD_COLLECTION);
			await clearItems(vendor, VALIDATION_COLLECTION);
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

			await ensureActionFlow(vendor);
			await clearItems(vendor, CANARY_COLLECTION);
			await awaitActionFlowReady(vendor);

			await clearItems(vendor, CANARY_COLLECTION);
		}
	}, 180000);

	afterAll(async () => {
		for (const [, db] of databases) {
			await db.destroy();
		}
	});

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

	describe('confined item writes', () => {
		it.each(vendors)(
			'%s denies a create for a role without create permission and persists no row',
			async (vendor) => {
				const marker = 'w1-role-b-denied';

				const reply = await runOperation(
					vendor,
					'currentUser',
					{ action: 'createOne', collection: TENANT_COLLECTION, payload: { tenant_id: 'B', title: marker } },
					TENANT_B_TOKEN
				);

				expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
				expect(await db(vendor)(TENANT_COLLECTION).where({ title: marker })).toHaveLength(0);
			},
			60000
		);

		it.each(vendors)(
			'%s denies an anonymous create at the service, distinct from missing accountability',
			async (vendor) => {
				const marker = 'w2-anon-denied';

				const reply = await runOperation(vendor, 'currentUser', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: { tenant_id: 'A', title: marker },
				});

				expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
				expect(await db(vendor)(TENANT_COLLECTION).where({ title: marker })).toHaveLength(0);
			},
			60000
		);

		it.each(vendors)(
			'%s persists a full-access nested create across the parent and its children',
			async (vendor) => {
				const marker = 'w3-nested-create';

				const reply = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: { tenant_id: 'A', title: marker, children: [{ label: 'c1' }, { label: 'c2' }] },
				});

				expect(reply.ok).toBe(true);
				const parentKey = (reply as { value: number | string }).value;
				expect(await db(vendor)(TENANT_COLLECTION).where({ id: parentKey })).toHaveLength(1);
				expect(await db(vendor)(CHILD_COLLECTION).where({ parent: parentKey })).toHaveLength(2);
			},
			60000
		);

		it.each(vendors)(
			'%s persists a scalar user foreign key and refuses a root directus_* write like a nonexistent collection',
			async (vendor) => {
				const marker = 'w4-owner-fk';
				const [firstUser] = await db(vendor)('directus_users').select('id').limit(1);
				const ownerId = (firstUser as { id: string }).id;

				const created = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: { tenant_id: 'A', title: marker, owner: ownerId },
				});

				expect(created.ok).toBe(true);
				const rows = await db(vendor)(TENANT_COLLECTION).where({ id: (created as { value: number | string }).value });
				expect(rows[0]?.owner).toBe(ownerId);

				const nonexistent = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: 'no_such_collection',
					payload: { title: marker },
				});

				expect(nonexistent).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });

				const usersBefore = await db(vendor)('directus_users').where({ email: 'w4-root@example.com' });

				for (const flow of ['system', 'currentUser'] as const) {
					const rootWrite = await runOperation(
						vendor,
						flow,
						{ action: 'createOne', collection: 'directus_users', payload: { email: 'w4-root@example.com' } },
						flow === 'currentUser' ? TENANT_A_TOKEN : undefined
					);

					expect(rootWrite).toEqual(nonexistent);
				}

				const usersAfter = await db(vendor)('directus_users').where({ email: 'w4-root@example.com' });
				expect(usersAfter).toHaveLength(usersBefore.length);
			},
			60000
		);

		it.each(vendors)(
			'%s rolls back a user create whose nested child is unauthorized',
			async (vendor) => {
				const marker = 'w6-nested-rollback';

				const reply = await runOperation(
					vendor,
					'currentUser',
					{
						action: 'createOne',
						collection: TENANT_COLLECTION,
						payload: { tenant_id: 'A', title: marker, children: [{ label: 'w6-child' }] },
					},
					TENANT_A_TOKEN
				);

				expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
				expect(await db(vendor)(TENANT_COLLECTION).where({ title: marker })).toHaveLength(0);
				expect(await db(vendor)(CHILD_COLLECTION).where({ label: 'w6-child' })).toHaveLength(0);
			},
			60000
		);

		it.each(vendors)(
			'%s admits a graph at the operator ceiling and rolls the whole graph back one past it',
			async (vendor) => {
				const limit = Number(config.envs[vendor]!.MAX_BATCH_MUTATION);

				const atLimit = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: {
						tenant_id: 'A',
						title: 'w7-at-limit',
						children: Array.from({ length: limit - 1 }, (_, index) => ({ label: `w7-ok-${index}` })),
					},
				});

				expect(atLimit.ok).toBe(true);
				const atLimitKey = (atLimit as { value: number | string }).value;
				expect(await db(vendor)(CHILD_COLLECTION).where({ parent: atLimitKey })).toHaveLength(limit - 1);

				const overLimit = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: {
						tenant_id: 'A',
						title: 'w7-over-limit',
						children: Array.from({ length: limit }, (_, index) => ({ label: `w7-over-${index}` })),
					},
				});

				expect(overLimit).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
				expect(await db(vendor)(TENANT_COLLECTION).where({ title: 'w7-over-limit' })).toHaveLength(0);
				expect(await db(vendor)(CHILD_COLLECTION).where('label', 'like', 'w7-over-%')).toHaveLength(0);
			},
			120000
		);

		it.each(vendors)(
			'%s rolls back a createMany when one element fails operator validation',
			async (vendor) => {
				const reply = await runOperation(
					vendor,
					'currentUser',
					{ action: 'createMany', collection: VALIDATION_COLLECTION, payloads: [{ amount: 5 }, { amount: -1 }] },
					TENANT_A_TOKEN
				);

				expect(reply).toMatchObject({
					ok: false,
					error: { code: 'invalid_request', message: 'the write failed validation' },
				});

				expect(await db(vendor)(VALIDATION_COLLECTION)).toHaveLength(0);
			},
			60000
		);

		it.each(vendors)(
			'%s answers a forbidden and a nonexistent updateOne identically and leaves the row unchanged',
			async (vendor) => {
				const forbidden = await runOperation(
					vendor,
					'currentUser',
					{
						action: 'updateOne',
						collection: TENANT_COLLECTION,
						key: rowIds[vendor]!.b,
						payload: { title: 'w13-hacked' },
					},
					TENANT_A_TOKEN
				);

				const missing = await runOperation(
					vendor,
					'currentUser',
					{ action: 'updateOne', collection: TENANT_COLLECTION, key: 999999999, payload: { title: 'w13-hacked' } },
					TENANT_A_TOKEN
				);

				expect(forbidden).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
				expect(missing).toEqual(forbidden);

				const rowB = await db(vendor)(TENANT_COLLECTION).where({ id: rowIds[vendor]!.b });
				expect(rowB[0]?.title).toBe('Beta record');
			},
			60000
		);

		it.each(vendors)(
			'%s records activity and a revision for user and full-access writes on a tracked collection',
			async (vendor) => {
				const [tenantAUser] = await db(vendor)('directus_users')
					.where({ email: 'confined-tenant-a@example.com' })
					.select('id');

				const userCreate = await runOperation(
					vendor,
					'currentUser',
					{ action: 'createOne', collection: TENANT_COLLECTION, payload: { tenant_id: 'A', title: 'w10-user' } },
					TENANT_A_TOKEN
				);

				expect(userCreate.ok).toBe(true);
				const userKey = String((userCreate as { value: number | string }).value);

				const userActivity = await db(vendor)('directus_activity').where({
					collection: TENANT_COLLECTION,
					item: userKey,
					action: 'create',
				});

				expect(userActivity).toHaveLength(1);
				expect(userActivity[0]?.user).toBe((tenantAUser as { id: string }).id);
				expect(await db(vendor)('directus_revisions').where({ collection: TENANT_COLLECTION, item: userKey })).toHaveLength(1);

				const systemCreate = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: { tenant_id: 'A', title: 'w10-system' },
				});

				expect(systemCreate.ok).toBe(true);
				const systemKey = String((systemCreate as { value: number | string }).value);

				const systemActivity = await db(vendor)('directus_activity').where({
					collection: TENANT_COLLECTION,
					item: systemKey,
					action: 'create',
				});

				expect(systemActivity).toHaveLength(1);
				expect(systemActivity[0]?.user).toBeNull();
				expect(await db(vendor)('directus_revisions').where({ collection: TENANT_COLLECTION, item: systemKey })).toHaveLength(
					1
				);
			},
			60000
		);

		it.each(vendors)(
			'%s records neither activity nor a revision on an accountability-off collection',
			async (vendor) => {
				const create = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: QUARANTINE_COLLECTION,
					payload: { note: 'w11-quarantine' },
				});

				expect(create.ok).toBe(true);
				const key = String((create as { value: number | string }).value);

				expect(await db(vendor)('directus_activity').where({ collection: QUARANTINE_COLLECTION, item: key })).toHaveLength(0);
				expect(await db(vendor)('directus_revisions').where({ collection: QUARANTINE_COLLECTION, item: key })).toHaveLength(
					0
				);
			},
			60000
		);

		it.each(vendors)(
			'%s preserves the platform validation floor on a nested preset despite an operator null-validation row',
			async (vendor) => {
				const [appRole] = await db(vendor)('directus_roles').where({ name: 'Confined Tenant App' }).select('id');

				const presetPermission = await db(vendor)('directus_permissions').where({
					role: (appRole as { id: string }).id,
					collection: 'directus_presets',
					action: 'create',
				});

				expect(presetPermission).toHaveLength(1);
				expect(presetPermission[0]?.validation).toBeNull();

				const [appUser] = await db(vendor)('directus_users')
					.where({ email: 'confined-tenant-app@example.com' })
					.select('id');

				const [otherUser] = await db(vendor)('directus_users')
					.where({ email: 'confined-tenant-a@example.com' })
					.select('id');

				const appUserId = (appUser as { id: string }).id;
				const otherUserId = (otherUser as { id: string }).id;

				const allowedBefore = await db(vendor)('directus_presets').where({ bookmark: 'w5-allowed' });

				const allowed = await runOperation(
					vendor,
					'currentUser',
					{
						action: 'createOne',
						collection: TENANT_COLLECTION,
						payload: {
							tenant_id: 'A',
							title: 'w5-allowed',
							preset: { user: appUserId, collection: TENANT_COLLECTION, bookmark: 'w5-allowed' },
						},
					},
					APP_TENANT_TOKEN
				);

				expect(allowed.ok).toBe(true);
				expect(await db(vendor)(TENANT_COLLECTION).where({ title: 'w5-allowed' })).toHaveLength(1);
				expect(await db(vendor)('directus_presets').where({ bookmark: 'w5-allowed' })).toHaveLength(
					allowedBefore.length + 1
				);

				const rejectedBefore = await db(vendor)('directus_presets').where({ bookmark: 'w5-floor' });

				const rejected = await runOperation(
					vendor,
					'currentUser',
					{
						action: 'createOne',
						collection: TENANT_COLLECTION,
						payload: {
							tenant_id: 'A',
							title: 'w5-floor',
							preset: { user: otherUserId, collection: TENANT_COLLECTION, bookmark: 'w5-floor' },
						},
					},
					APP_TENANT_TOKEN
				);

				expect(rejected).toMatchObject({
					ok: false,
					error: { code: 'invalid_request', message: 'the write failed validation' },
				});

				expect(await db(vendor)(TENANT_COLLECTION).where({ title: 'w5-floor' })).toHaveLength(0);
				expect(await db(vendor)('directus_presets').where({ bookmark: 'w5-floor' })).toHaveLength(rejectedBefore.length);
			},
			60000
		);

		it.each(vendors)(
			'%s applies the create filter and fires the operator action flow on a committed write',
			async (vendor) => {
				const create = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: { tenant_id: 'A', title: 'canary-modify', probe_tag: 'w8' },
				});

				expect(create.ok).toBe(true);
				const key = (create as { value: number | string }).value;

				const rows = await db(vendor)(TENANT_COLLECTION).where({ id: key });
				expect(rows[0]?.public_body).toBe('canary-touched');

				expect(await waitForCanaryEvent(vendor, 'w8')).toBe(true);
			},
			60000
		);

		it.each(vendors)(
			'%s fires parent and child action events for a committed graph but none for a rolled-back one',
			async (vendor) => {
				const limit = Number(config.envs[vendor]!.MAX_BATCH_MUTATION);

				const controlStarted = Date.now();

				const control = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: {
						tenant_id: 'A',
						title: 'w9-control',
						probe_tag: 'w9c-parent',
						children: [{ label: 'w9-control-child', probe_tag: 'w9c-child' }],
					},
				});

				expect(control.ok).toBe(true);
				expect(await waitForCanaryEvent(vendor, 'w9c-parent')).toBe(true);
				expect(await waitForCanaryEvent(vendor, 'w9c-child')).toBe(true);

				const observedLatency = Date.now() - controlStarted;
				// Action handlers are fire-and-forget, so settle against the observed control latency.
				const settle = () => sleep(Math.min(observedLatency * 3 + 1000, 15000));

				const permissionRollback = await runOperation(
					vendor,
					'currentUser',
					{
						action: 'createOne',
						collection: TENANT_COLLECTION,
						payload: {
							tenant_id: 'A',
							title: 'w9-perm',
							probe_tag: 'w9perm-parent',
							children: [{ label: 'w9-perm-child', probe_tag: 'w9perm-child' }],
						},
					},
					TENANT_A_TOKEN
				);

				expect(permissionRollback).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });

				const ceilingRollback = await runOperation(vendor, 'system', {
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: {
						tenant_id: 'A',
						title: 'w9-ceiling',
						probe_tag: 'w9ceil-parent',
						children: Array.from({ length: limit }, (_, index) => ({
							label: `w9-ceiling-${index}`,
							probe_tag: 'w9ceil-child',
						})),
					},
				});

				expect(ceilingRollback).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

				await settle();

				for (const tag of ['w9perm-parent', 'w9perm-child', 'w9ceil-parent', 'w9ceil-child']) {
					expect(await db(vendor)(CANARY_COLLECTION).where({ event: tag })).toHaveLength(0);
				}

				expect(await db(vendor)(TENANT_COLLECTION).whereIn('title', ['w9-perm', 'w9-ceiling'])).toHaveLength(0);
				expect(await db(vendor)(CHILD_COLLECTION).whereIn('probe_tag', ['w9perm-child', 'w9ceil-child'])).toHaveLength(0);
			},
			120000
		);
	});
});
