import { setupRequest, assertSetupResponse } from '../../fixtures/request';
import { describe, expect, vi } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateFieldM2O, CreateFieldO2M, CreateRole } from '../../fixtures/schema';
import request, { CreateItem } from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import type { Knex } from 'knex';
import type { Test, Response } from 'supertest';
import { isEqual } from 'lodash';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

vi.setConfig({ hookTimeout: 180_000 });
initializeFixtures();

type FlowApi = Api & { flowIds: { currentUser: string; system: string } };
type ConfinedApi = FlowApi & { rowIds: { a: number; b: number; quarantined: number } };

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

type HostReply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

function admin(req: Test): Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`);
}

async function clearItems(api: Api, collection: string) {
	const existing = expectOk(
		await admin(
			request(api.url)
				.get(`/items/${collection}`)
				.query({ fields: ['id'], limit: -1 })
		),
		`read items ${collection}`
	);

	const ids = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	// Deleted in batches, because a reset after a run that filled a relational graph can
	// exceed the operator mutation limit that applies to this request too.
	const batch = api.maxBatchMutation;

	for (let index = 0; index < ids.length; index += batch) {
		expectOk(
			await admin(request(api.url).delete(`/items/${collection}`)).send(ids.slice(index, index + batch)),
			`clear items ${collection}`
		);
	}
}

async function ensureFields(api: Api, collection: string, fields: { field: string; type: string }[]) {
	const existing = expectOk(
		await admin(setupRequest(api.url).get(`/fields/${collection}`)),
		`read fields ${collection}`
	);

	const present = new Set((existing.body.data ?? []).map((entry: { field: string }) => entry.field));

	for (const field of fields) {
		if (present.has(field.field)) continue;

		expectOk(
			await admin(setupRequest(api.url).post(`/fields/${collection}`)).send({ ...field, meta: {}, schema: {} }),
			`create field ${collection}.${field.field}`
		);
	}

	const settled = expectOk(
		await admin(setupRequest(api.url).get(`/fields/${collection}`)),
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

function expectOk(res: Response, label: string): Response {
	try {
		return assertSetupResponse(res);
	} catch (error) {
		throw new Error(`${label}: ${(error as Error).message}`);
	}
}

type FieldShape = { type: string; meta: { special?: string[] | null } | null };

type RelationShape = {
	related_collection: string | null;
	meta: { one_field?: string | null } | null;
	schema: { foreign_key_table?: string | null } | null;
};

async function getField(api: Api, collection: string, field: string): Promise<FieldShape | null> {
	const res = expectOk(await admin(setupRequest(api.url).get(`/fields/${collection}`)), `read fields ${collection}`);
	return (res.body.data ?? []).find((entry: { field: string }) => entry.field === field) ?? null;
}

async function fieldExists(api: Api, collection: string, field: string): Promise<boolean> {
	return (await getField(api, collection, field)) !== null;
}

async function deleteFieldIfExists(api: Api, collection: string, field: string) {
	if (await fieldExists(api, collection, field)) {
		expectOk(
			await admin(setupRequest(api.url).delete(`/fields/${collection}/${field}`)),
			`delete ${collection}.${field}`
		);
	}
}

async function getRelation(api: Api, collection: string, field: string): Promise<RelationShape | null> {
	const res = await admin(request(api.url).get(`/relations/${collection}/${field}`));
	// The relation endpoint conceals missing relations as forbidden.
	if (res.status === 404 || res.status === 403) return null;
	expectOk(res, `read relation ${collection}.${field}`);
	return res.body.data ?? null;
}

async function m2oCorrect(api: Api, collection: string, field: string, related: string): Promise<boolean> {
	const relation = await getRelation(api, collection, field);
	const shape = await getField(api, collection, field);

	return (
		relation?.related_collection === related &&
		relation.schema?.foreign_key_table === related &&
		(shape?.meta?.special ?? []).includes('m2o')
	);
}

async function ensureM2O(api: Api, collection: string, field: string, related: string, pkType: 'uuid' | 'integer') {
	if (await m2oCorrect(api, collection, field, related)) return;

	await deleteFieldIfExists(api, collection, field);
	await CreateFieldM2O(api, { collection, field, otherCollection: related, primaryKeyType: pkType });

	if (!(await m2oCorrect(api, collection, field, related))) {
		throw new Error(`m2o ${collection}.${field} -> ${related} not established`);
	}
}

async function o2mCorrect(
	api: Api,
	collection: string,
	alias: string,
	childCollection: string,
	childField: string
): Promise<boolean> {
	const relation = await getRelation(api, childCollection, childField);
	const aliasField = await getField(api, collection, alias);

	return (
		relation?.related_collection === collection &&
		relation?.meta?.one_field === alias &&
		aliasField?.type === 'alias' &&
		(aliasField?.meta?.special ?? []).includes('o2m')
	);
}

async function ensureO2M(api: Api, collection: string, alias: string, childCollection: string, childField: string) {
	if (await o2mCorrect(api, collection, alias, childCollection, childField)) return;

	await deleteFieldIfExists(api, childCollection, childField);
	await deleteFieldIfExists(api, collection, alias);
	await CreateFieldO2M(api, { collection, field: alias, otherCollection: childCollection, otherField: childField });

	if (!(await o2mCorrect(api, collection, alias, childCollection, childField))) {
		throw new Error(`o2m ${collection}.${alias} <- ${childCollection}.${childField} not established`);
	}
}

async function ensureCollectionAccountability(api: Api, collection: string, value: 'all' | 'activity' | null) {
	expectOk(
		await admin(setupRequest(api.url).patch(`/collections/${collection}`)).send({ meta: { accountability: value } }),
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
async function ensurePermission(api: Api, spec: PermissionSpec) {
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
			setupRequest(api.url)
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
			await admin(setupRequest(api.url).post('/permissions')).send(expected),
			`create permission ${spec.collection}.${spec.action}`
		);

		return;
	}

	expectOk(
		await admin(setupRequest(api.url).patch(`/permissions/${found[0]}`)).send(expected),
		`patch permission ${spec.collection}.${spec.action}`
	);

	if (found.length > 1) {
		expectOk(
			await admin(setupRequest(api.url).delete('/permissions')).send(found.slice(1)),
			`dedupe permission ${spec.collection}.${spec.action}`
		);
	}
}

async function ensureNoPermission(api: Api, role: string | null, collection: string, action: string) {
	const existing = expectOk(
		await admin(
			setupRequest(api.url)
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
			await admin(setupRequest(api.url).delete('/permissions')).send(found),
			`delete permissions ${collection}.${action}`
		);
	}
}

async function ensureReadPermission(api: Api, role: string, tenant: string) {
	await ensurePermission(api, {
		role,
		collection: TENANT_COLLECTION,
		action: 'read',
		permissions: { tenant_id: { _eq: tenant } },
		fields: ['id', 'tenant_id', 'title', 'public_body'],
	});
}

async function ensureRole(api: Api, name: string, appAccess: boolean) {
	const role = await CreateRole(api, { name, appAccessEnabled: appAccess, adminAccessEnabled: false });

	expectOk(
		await admin(setupRequest(api.url).patch(`/roles/${role.id}`)).send({ app_access: appAccess, admin_access: false }),
		`role ${name} flags`
	);

	return role;
}

async function ensureUser(api: Api, email: string, role: string, token: string) {
	const existing = expectOk(
		await admin(
			setupRequest(api.url)
				.get('/users')
				.query({ filter: { email: { _eq: email } }, fields: ['id'] })
		),
		`read user ${email}`
	);

	const found = existing.body.data ?? [];

	if (found.length > 0) {
		expectOk(
			await admin(setupRequest(api.url).patch(`/users/${found[0].id}`)).send({ role, token }),
			`patch user ${email}`
		);
	} else {
		expectOk(await admin(setupRequest(api.url).post('/users')).send({ email, role, token }), `create user ${email}`);
	}

	const settled = expectOk(
		await admin(
			setupRequest(api.url)
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
		await setupRequest(api.url)
			.get('/users/me')
			.query({ fields: ['id'] })
			.set('Authorization', `Bearer ${token}`),
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
async function ensureProbeFlow(api: Api, name: string, type: string): Promise<string> {
	const existingFlows = expectOk(
		await admin(
			setupRequest(api.url)
				.get('/flows')
				.query({ filter: { name: { _eq: name } }, fields: ['id'], limit: -1 })
		),
		`read flows ${name}`
	);

	const flowIdsFound = (existingFlows.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (flowIdsFound.length > 1) {
		expectOk(await admin(setupRequest(api.url).delete('/flows')).send(flowIdsFound.slice(1)), `dedupe flows ${name}`);
	}

	let flowId: string;

	if (flowIdsFound.length > 0) {
		flowId = flowIdsFound[0];
	} else {
		const created = expectOk(
			await admin(
				setupRequest(api.url)
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
			setupRequest(api.url)
				.get('/operations')
				.query({ filter: { flow: { _eq: flowId } }, fields: ['id'], limit: -1 })
		),
		`read operations ${name}`
	);

	const operationIds = (existingOperations.body.data ?? []).map((operation: { id: string }) => operation.id);

	if (operationIds.length > 1) {
		expectOk(
			await admin(setupRequest(api.url).delete('/operations')).send(operationIds.slice(1)),
			`dedupe operations ${name}`
		);
	}

	const operation = { name: 'probe', key: 'probe', type, position_x: 1, position_y: 1, options: PROBE_OPTIONS };

	let operationId: string;

	if (operationIds.length > 0) {
		operationId = operationIds[0];

		expectOk(
			await admin(setupRequest(api.url).patch(`/operations/${operationId}`)).send(operation),
			`patch operation ${name}`
		);
	} else {
		const created = expectOk(
			await admin(
				setupRequest(api.url)
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
		await admin(setupRequest(api.url).patch(`/flows/${flowId}`)).send({ ...PROBE_FLOW, operation: operationId }),
		`link operation ${name}`
	);

	const settled = expectOk(
		await admin(
			setupRequest(api.url)
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
			setupRequest(api.url)
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
async function awaitFlowReady(api: Api, flowId: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const response = await request(api.url)
			.post(`/flows/trigger/${flowId}`)
			.send({ action: 'read', collection: TENANT_COLLECTION, key: 0, query: {} });

		if (response.status === 200 && response.body !== null && typeof response.body.ok === 'boolean') return;

		await sleep(100);
	}

	throw new Error(`the confined operation flow ${flowId} never produced a host reply`);
}

async function runOperation(
	api: FlowApi,
	flow: 'currentUser' | 'system',
	body: Record<string, unknown>,
	token?: string
): Promise<HostReply> {
	const trigger = request(api.url).post(`/flows/trigger/${api.flowIds[flow]}`);
	if (token) trigger.set('Authorization', `Bearer ${token}`);

	const response = await trigger.send({ action: 'read', key: 0, query: {}, ...body });

	if (response.status !== 200 || response.body === null || typeof response.body.ok !== 'boolean') {
		throw new Error(`the confined operation trigger answered ${response.status} without a host reply`);
	}

	return response.body;
}

async function readCanaryEvents(api: Api): Promise<string[]> {
	// Asserted, because this feeds absence assertions where a failed read would
	// otherwise become an empty result and pass for the wrong reason.
	const fired = expectOk(
		await admin(
			request(api.url)
				.get(`/items/${CANARY_COLLECTION}`)
				.query({ fields: ['event'], limit: -1 })
		),
		'read canary events'
	);

	return (fired.body.data ?? []).map((row: { event: string }) => row.event);
}

async function waitForCanaryEvent(api: Api, marker: string): Promise<boolean> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const rows = await db(api)(CANARY_COLLECTION).where({ event: marker });
		if (rows.length > 0) return true;
		await sleep(100);
	}

	return false;
}

async function ensureActionFlow(api: Api) {
	const existing = expectOk(
		await admin(
			setupRequest(api.url)
				.get('/flows')
				.query({ filter: { name: { _eq: ACTION_FLOW_NAME } }, fields: ['id'], limit: -1 })
		),
		'read action flows'
	);

	const ids = (existing.body.data ?? []).map((flow: { id: string }) => flow.id);

	if (ids.length > 0) {
		expectOk(await admin(setupRequest(api.url).delete('/flows')).send(ids), 'delete stale action flows');
	}

	const flow = expectOk(
		await admin(setupRequest(api.url).post('/flows')).send({
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
		await admin(setupRequest(api.url).post('/operations')).send({
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
		await admin(setupRequest(api.url).patch(`/flows/${flowId}`)).send({ operation: operation.body.data.id }),
		'link action operation'
	);

	return flowId;
}

async function awaitActionFlowReady(api: FlowApi, teardownFailures: unknown[]) {
	const keys: (number | string)[] = [];

	try {
		for (let attempt = 0; attempt < 30; attempt++) {
			const reply = await runOperation(api, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'PROBE', title: 'action-flow-probe', probe_tag: 'action-flow-probe' },
			});

			if (!reply.ok) throw new Error(`the action flow probe write failed: ${JSON.stringify(reply)}`);
			keys.push((reply as { value: number | string }).value);

			const rows = await db(api)(CANARY_COLLECTION).where({ event: 'action-flow-probe' });
			if (rows.length > 0) return;

			await sleep(200);
		}

		throw new Error('the action flow never registered its items.create listener');
	} finally {
		if (keys.length > 0) {
			try {
				await db(api)(TENANT_COLLECTION).whereIn('id', keys).del();
			} catch (error) {
				teardownFailures.push(error);
			}
		}
	}
}

function db(api: Api): Knex {
	return api.database;
}

const test = createIdentityTest({ extensions: [CURRENT_USER_OPERATION, SYSTEM_OPERATION, CANARY_HOOK] }).extend<{
	schemaState: Prerequisite<FlowApi>;
	schema: FlowApi;
	confined: ConfinedApi;
	actionFlow: void;
}>({
	schemaState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<FlowApi>(
				async (ready) => {
					// The canary collection comes first so the canary hook can record from the
					// moment the tenant collection exists.
					await CreateCollection(api, {
						collection: CANARY_COLLECTION,
						fields: [{ field: 'event', type: 'string', meta: {}, schema: {} }],
					});

					await CreateCollection(api, {
						collection: TENANT_COLLECTION,
						fields: TENANT_FIELDS.map((field) => ({ ...field, meta: {}, schema: {} })),
					});

					await CreateCollection(api, {
						collection: QUARANTINE_COLLECTION,
						fields: [{ field: 'note', type: 'string', meta: {}, schema: {} }],
					});

					await ensureFields(api, TENANT_COLLECTION, TENANT_FIELDS);

					await CreateCollection(api, {
						collection: CHILD_COLLECTION,
						meta: { accountability: null },
						fields: CHILD_FIELDS.map((field) => ({ ...field, meta: {}, schema: {} })),
					});

					await ensureFields(api, CHILD_COLLECTION, CHILD_FIELDS);

					await CreateCollection(api, {
						collection: VALIDATION_COLLECTION,
						fields: [{ field: 'amount', type: 'integer', meta: {}, schema: {} }],
					});

					await ensureCollectionAccountability(api, TENANT_COLLECTION, 'all');
					await ensureCollectionAccountability(api, QUARANTINE_COLLECTION, null);
					await ensureCollectionAccountability(api, CHILD_COLLECTION, null);
					await ensureCollectionAccountability(api, VALIDATION_COLLECTION, 'all');

					await ensureO2M(api, TENANT_COLLECTION, 'children', CHILD_COLLECTION, 'parent');
					await ensureM2O(api, TENANT_COLLECTION, 'owner', 'directus_users', 'uuid');
					await ensureM2O(api, TENANT_COLLECTION, 'preset', 'directus_presets', 'integer');

					const roleA = await ensureRole(api, 'Confined Tenant A', false);
					const roleB = await ensureRole(api, 'Confined Tenant B', false);

					await ensureReadPermission(api, roleA.id, 'A');
					await ensureReadPermission(api, roleB.id, 'B');

					await ensureUser(api, 'confined-tenant-a@example.com', roleA.id, TENANT_A_TOKEN);
					await ensureUser(api, 'confined-tenant-b@example.com', roleB.id, TENANT_B_TOKEN);

					const roleApp = await ensureRole(api, 'Confined Tenant App', true);

					await ensureUser(api, 'confined-tenant-app@example.com', roleApp.id, APP_TENANT_TOKEN);

					await ensurePermission(api, {
						role: roleA.id,
						collection: TENANT_COLLECTION,
						action: 'create',
						validation: { tenant_id: { _eq: 'A' } },
					});

					await ensurePermission(api, {
						role: roleA.id,
						collection: TENANT_COLLECTION,
						action: 'update',
						permissions: { tenant_id: { _eq: 'A' } },
						validation: { tenant_id: { _eq: 'A' } },
					});

					await ensurePermission(api, {
						role: roleA.id,
						collection: VALIDATION_COLLECTION,
						action: 'create',
						validation: { amount: { _gte: 0 } },
					});

					await ensurePermission(api, { role: roleApp.id, collection: TENANT_COLLECTION, action: 'create' });

					await ensurePermission(api, {
						role: roleApp.id,
						collection: 'directus_presets',
						action: 'create',
						validation: null,
					});

					await ensureNoPermission(api, roleB.id, TENANT_COLLECTION, 'create');
					await ensureNoPermission(api, null, TENANT_COLLECTION, 'create');
					await ensureNoPermission(api, roleA.id, CHILD_COLLECTION, 'create');

					const currentUser = await ensureProbeFlow(
						api,
						'confined items host probe (current-user)',
						CURRENT_USER_OPERATION
					);

					const system = await ensureProbeFlow(api, 'confined items host probe (system)', SYSTEM_OPERATION);

					const flowIds = { currentUser, system };

					await awaitFlowReady(api, currentUser);
					await awaitFlowReady(api, system);

					await ready({ ...api, flowIds });
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
			await use(requirePrerequisite(schemaState, 'confined item schema, permissions and flows', { task, skip }));
		},
		{ auto: true },
	],
	confined: async ({ schema: api }, use) => {
		// Reset through SQL so fixture cleanup cannot emit read/action events under test.
		for (const collection of [
			CHILD_COLLECTION,
			VALIDATION_COLLECTION,
			TENANT_COLLECTION,
			QUARANTINE_COLLECTION,
			CANARY_COLLECTION,
		]) {
			await api.database(collection).delete();
		}

		await api.database('directus_presets').whereIn('bookmark', ['w5-allowed', 'w5-floor']).delete();

		const rowA = await CreateItem(api, {
			collection: TENANT_COLLECTION,
			item: {
				tenant_id: 'A',
				title: 'Alpha record',
				public_body: 'alpha public body',
				private_note: 'alpha secret note',
			},
		});

		const rowB = await CreateItem(api, {
			collection: TENANT_COLLECTION,
			item: {
				tenant_id: 'B',
				title: 'Beta record',
				public_body: 'beta public body',
				private_note: 'beta secret note',
			},
		});

		const quarantined = await CreateItem(api, {
			collection: QUARANTINE_COLLECTION,
			item: { note: 'quarantined' },
		});

		const rowIds = { a: rowA.id, b: rowB.id, quarantined: quarantined.id };

		await use({ ...api, rowIds });
	},
	actionFlow: async ({ confined: api, teardownFailures }, use) => {
		// Only the event-delivery cases need the operator's asynchronous action flow.
		const flowId = await ensureActionFlow(api);

		try {
			await awaitActionFlowReady(api, teardownFailures);
			await api.database(CANARY_COLLECTION).delete();
			await use();
		} finally {
			try {
				await admin(setupRequest(api.url).delete(`/flows/${flowId}`)).expect(204);
			} catch (error) {
				teardownFailures.push(error);
			}
		}
	},
});

describe('Confined items host through the real flow binding', () => {
	describe('fixture registration', () => {
		test('loads the confined items fixtures and the canary through the real loader', async ({ confined: api }) => {
			const response = await admin(request(api.url).get('/extensions')).expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			expect(byName[CURRENT_USER_OPERATION]?.status).toBe('loaded');
			expect(byName[SYSTEM_OPERATION]?.status).toBe('loaded');
			expect(byName[CANARY_HOOK]?.status).toBe('loaded');
		});
	});

	describe('tenant row isolation', () => {
		test('returns each tenant only its own rows and never the hidden field', async ({ confined: api }) => {
			const replyA = await runOperation(
				api,
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
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { fields: ['*'] } },
				TENANT_B_TOKEN
			);

			expect(replyB.ok).toBe(true);
			const rowsB = (replyB as { value: Record<string, unknown>[] }).value;
			expect(rowsB).toHaveLength(1);
			expect(rowsB[0]?.['title']).toBe('Beta record');
			expect(rowsB[0]).not.toHaveProperty('private_note');
		}, 60000);
	});

	describe('hidden fields are not an oracle', () => {
		test('answers a hidden field and a nonexistent field identically on select', async ({ confined: api }) => {
			const hidden = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { fields: ['private_note'] } },
				TENANT_A_TOKEN
			);

			const missing = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { fields: ['no_such_field'] } },
				TENANT_A_TOKEN
			);

			expect(hidden.ok).toBe(false);
			expect(missing).toEqual(hidden);
		}, 60000);

		test('answers a hidden field and a nonexistent field identically on filter', async ({ confined: api }) => {
			const hidden = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { filter: { private_note: { _eq: 'alpha secret note' } } } },
				TENANT_A_TOKEN
			);

			const missing = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { filter: { no_such_field: { _eq: 'alpha secret note' } } } },
				TENANT_A_TOKEN
			);

			expect(hidden.ok).toBe(false);
			expect(JSON.stringify(hidden)).not.toContain('secret note');
			expect(missing).toEqual(hidden);
		}, 60000);

		test('answers a hidden field and a nonexistent field identically on sort', async ({ confined: api }) => {
			const hidden = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { sort: ['private_note'] } },
				TENANT_A_TOKEN
			);

			const missing = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { sort: ['no_such_field'] } },
				TENANT_A_TOKEN
			);

			expect(hidden.ok).toBe(false);
			expect(missing).toEqual(hidden);
		}, 60000);

		test('does not match hidden field content through search', async ({ confined: api }) => {
			const secret = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { search: 'secret note' } },
				TENANT_A_TOKEN
			);

			expect(secret.ok).toBe(true);
			expect((secret as { value: unknown[] }).value).toHaveLength(0);

			const visible = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { search: 'public body' } },
				TENANT_A_TOKEN
			);

			expect(visible.ok).toBe(true);
			const rows = (visible as { value: Record<string, unknown>[] }).value;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.['title']).toBe('Alpha record');
		}, 60000);
	});

	describe('readOne forbidden and missing collapse', () => {
		test("answers another tenant's row and a missing row identically", async ({ confined: api }) => {
			const forbidden = await runOperation(
				api,
				'currentUser',
				{ action: 'readOne', collection: TENANT_COLLECTION, key: api.rowIds.b },
				TENANT_A_TOKEN
			);

			const missing = await runOperation(
				api,
				'currentUser',
				{ action: 'readOne', collection: TENANT_COLLECTION, key: 999999 },
				TENANT_A_TOKEN
			);

			expect(forbidden).toEqual({ ok: true, value: null });
			expect(missing).toEqual({ ok: true, value: null });
		}, 60000);
	});

	describe('collection visibility is not an oracle', () => {
		test('answers a denied collection and a nonexistent collection identically', async ({ confined: api }) => {
			const denied = await runOperation(api, 'currentUser', { collection: QUARANTINE_COLLECTION }, TENANT_A_TOKEN);

			const missing = await runOperation(api, 'currentUser', { collection: 'no_such_collection' }, TENANT_A_TOKEN);

			expect(denied.ok).toBe(false);
			expect(missing).toEqual(denied);

			const deniedOne = await runOperation(
				api,
				'currentUser',
				{ action: 'readOne', collection: QUARANTINE_COLLECTION, key: api.rowIds.quarantined },
				TENANT_A_TOKEN
			);

			const missingOne = await runOperation(
				api,
				'currentUser',
				{ action: 'readOne', collection: 'no_such_collection', key: 1 },
				TENANT_A_TOKEN
			);

			expect(deniedOne).toEqual({ ok: true, value: null });
			expect(missingOne).toEqual(deniedOne);
		}, 60000);
	});

	describe('top-level system collections are refused', () => {
		test('refuses a top-level directus_* system collection under full-access, identically to a nonexistent collection', async ({
			confined: api,
		}) => {
			const refused = await runOperation(api, 'system', { collection: 'directus_users' });

			const missing = await runOperation(api, 'system', { collection: 'no_such_collection' });

			expect(refused).toMatchObject({ ok: false, error: { code: 'denied' } });
			expect(missing).toEqual(refused);
		}, 60000);

		test('collapses a top-level directus_* readOne of a real user to null under full-access', async ({
			confined: api,
		}) => {
			const existing = await request(api.url).get('/users/me').auth(api.adminToken, { type: 'bearer' }).expect(200);
			expect(typeof existing.body.data.id).toBe('string');

			const refused = await runOperation(api, 'system', {
				action: 'readOne',
				collection: 'directus_users',
				key: existing.body.data.id,
			});

			expect(refused).toEqual({ ok: true, value: null });
		}, 60000);
	});

	describe('caller authority', () => {
		test('reads as public for an unauthenticated caller and is denied without a public grant', async ({
			confined: api,
		}) => {
			const reply = await runOperation(api, 'currentUser', { collection: TENANT_COLLECTION });

			expect(reply.ok).toBe(false);
			expect(JSON.stringify(reply)).not.toContain('secret note');
		}, 60000);

		test('elevates only because the manifest declared system, not because of the caller', async ({ confined: api }) => {
			const reply = await runOperation(api, 'system', {
				collection: TENANT_COLLECTION,
				query: { fields: ['*'], sort: ['id'] },
			});

			expect(reply.ok).toBe(true);
			const rows = (reply as { value: Record<string, unknown>[] }).value;
			expect(rows).toHaveLength(2);
			expect(rows[0]?.['private_note']).toBe('alpha secret note');
			expect(rows[1]?.['private_note']).toBe('beta secret note');
		}, 60000);
	});

	describe('broker query bounds through the real path', () => {
		test('refuses an unsupported query feature before the service runs', async ({ confined: api }) => {
			const reply = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { deep: { related: { _limit: 1 } } } },
				TENANT_A_TOKEN
			);

			expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}, 60000);

		test('refuses a malformed limit and accepts an over-cap limit clamped', async ({ confined: api }) => {
			const malformed = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { limit: 0 } },
				TENANT_A_TOKEN
			);

			expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

			// An over-cap limit is clamped to the broker maximum, not refused.
			const clamped = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { limit: 101 } },
				TENANT_A_TOKEN
			);

			expect(clamped.ok).toBe(true);
		}, 60000);
	});

	describe('brokered reads do not fire item events', () => {
		test('records platform read events but none for a brokered read', async ({ confined: api }) => {
			await clearItems(api, CANARY_COLLECTION);

			// Positive control: a platform REST read fires the canary hook, proving
			// the canary observes this collection's events. The read action emission
			// is not awaited by the read path, so poll briefly.
			const controlStarted = performance.now();

			await admin(request(api.url).get(`/items/${TENANT_COLLECTION}`)).expect(200);

			let events: string[] = [];

			for (let attempt = 0; attempt < 50; attempt++) {
				events = await readCanaryEvents(api);
				if (events.includes('query') && events.includes('read')) break;
				await sleep(100);
			}

			expect(events).toContain('query');
			expect(events).toContain('read');

			const observedLatency = performance.now() - controlStarted;

			await clearItems(api, CANARY_COLLECTION);

			const reply = await runOperation(
				api,
				'currentUser',
				{ collection: TENANT_COLLECTION, query: { fields: ['*'] } },
				TENANT_A_TOKEN
			);

			expect(reply.ok).toBe(true);

			// Absence cannot be polled for, so settle for a multiple of the emission
			// latency the positive control just measured, bounded by the test timeout.
			await sleep(Math.min(observedLatency * 3 + 1000, 15000));

			expect(await readCanaryEvents(api)).toEqual([]);
		}, 60000);
	});

	describe('host.items cannot reach an internal table', () => {
		test('answers a request for cairncms_extension_settings with a host error', async ({ confined: api }) => {
			const reply = await runOperation(
				api,
				'currentUser',
				{ collection: 'cairncms_extension_settings' },
				TENANT_A_TOKEN
			);

			expect(reply.ok).toBe(false);
		}, 60000);
	});

	describe('confined item writes', () => {
		test('denies a create for a role without create permission and persists no row', async ({ confined: api }) => {
			const marker = 'w1-role-b-denied';

			const reply = await runOperation(
				api,
				'currentUser',
				{ action: 'createOne', collection: TENANT_COLLECTION, payload: { tenant_id: 'B', title: marker } },
				TENANT_B_TOKEN
			);

			expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
			expect(await db(api)(TENANT_COLLECTION).where({ title: marker })).toHaveLength(0);
		}, 60000);

		test('denies an anonymous create at the service, distinct from missing accountability', async ({
			confined: api,
		}) => {
			const marker = 'w2-anon-denied';

			const reply = await runOperation(api, 'currentUser', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'A', title: marker },
			});

			expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
			expect(await db(api)(TENANT_COLLECTION).where({ title: marker })).toHaveLength(0);
		}, 60000);

		test('persists a full-access nested create across the parent and its children', async ({ confined: api }) => {
			const marker = 'w3-nested-create';

			const reply = await runOperation(api, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'A', title: marker, children: [{ label: 'c1' }, { label: 'c2' }] },
			});

			expect(reply.ok).toBe(true);
			const parentKey = (reply as { value: number | string }).value;
			expect(await db(api)(TENANT_COLLECTION).where({ id: parentKey })).toHaveLength(1);
			expect(await db(api)(CHILD_COLLECTION).where({ parent: parentKey })).toHaveLength(2);
		}, 60000);

		test('persists a scalar user foreign key and refuses a root directus_* write like a nonexistent collection', async ({
			confined: api,
		}) => {
			const marker = 'w4-owner-fk';
			const [firstUser] = await db(api)('directus_users').select('id').limit(1);
			const ownerId = (firstUser as { id: string }).id;

			const created = await runOperation(api, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'A', title: marker, owner: ownerId },
			});

			expect(created.ok).toBe(true);
			const rows = await db(api)(TENANT_COLLECTION).where({ id: (created as { value: number | string }).value });
			expect(rows[0]?.owner).toBe(ownerId);

			const nonexistent = await runOperation(api, 'system', {
				action: 'createOne',
				collection: 'no_such_collection',
				payload: { title: marker },
			});

			expect(nonexistent).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });

			const usersBefore = await db(api)('directus_users').where({ email: 'w4-root@example.com' });

			for (const flow of ['system', 'currentUser'] as const) {
				const rootWrite = await runOperation(
					api,
					flow,
					{ action: 'createOne', collection: 'directus_users', payload: { email: 'w4-root@example.com' } },
					flow === 'currentUser' ? TENANT_A_TOKEN : undefined
				);

				expect(rootWrite).toEqual(nonexistent);
			}

			const usersAfter = await db(api)('directus_users').where({ email: 'w4-root@example.com' });
			expect(usersAfter).toHaveLength(usersBefore.length);
		}, 60000);

		test('rolls back a user create whose nested child is unauthorized', async ({ confined: api }) => {
			const marker = 'w6-nested-rollback';

			const reply = await runOperation(
				api,
				'currentUser',
				{
					action: 'createOne',
					collection: TENANT_COLLECTION,
					payload: { tenant_id: 'A', title: marker, children: [{ label: 'w6-child' }] },
				},
				TENANT_A_TOKEN
			);

			expect(reply).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
			expect(await db(api)(TENANT_COLLECTION).where({ title: marker })).toHaveLength(0);
			expect(await db(api)(CHILD_COLLECTION).where({ label: 'w6-child' })).toHaveLength(0);
		}, 60000);

		test('admits a graph at the operator ceiling and rolls the whole graph back one past it', async ({
			confined: api,
		}) => {
			const limit = api.maxBatchMutation;

			const atLimit = await runOperation(api, 'system', {
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
			expect(await db(api)(CHILD_COLLECTION).where({ parent: atLimitKey })).toHaveLength(limit - 1);

			const overLimit = await runOperation(api, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: {
					tenant_id: 'A',
					title: 'w7-over-limit',
					children: Array.from({ length: limit }, (_, index) => ({ label: `w7-over-${index}` })),
				},
			});

			expect(overLimit).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
			expect(await db(api)(TENANT_COLLECTION).where({ title: 'w7-over-limit' })).toHaveLength(0);
			expect(await db(api)(CHILD_COLLECTION).where('label', 'like', 'w7-over-%')).toHaveLength(0);
		}, 120000);

		test('rolls back a createMany when one element fails operator validation', async ({ confined: api }) => {
			const reply = await runOperation(
				api,
				'currentUser',
				{ action: 'createMany', collection: VALIDATION_COLLECTION, payloads: [{ amount: 5 }, { amount: -1 }] },
				TENANT_A_TOKEN
			);

			expect(reply).toMatchObject({
				ok: false,
				error: { code: 'invalid_request', message: 'the write failed validation' },
			});

			expect(await db(api)(VALIDATION_COLLECTION)).toHaveLength(0);
		}, 60000);

		test('answers a forbidden and a nonexistent updateOne identically and leaves the row unchanged', async ({
			confined: api,
		}) => {
			const forbidden = await runOperation(
				api,
				'currentUser',
				{
					action: 'updateOne',
					collection: TENANT_COLLECTION,
					key: api.rowIds.b,
					payload: { title: 'w13-hacked' },
				},
				TENANT_A_TOKEN
			);

			const missing = await runOperation(
				api,
				'currentUser',
				{ action: 'updateOne', collection: TENANT_COLLECTION, key: 999999999, payload: { title: 'w13-hacked' } },
				TENANT_A_TOKEN
			);

			expect(forbidden).toEqual({ ok: false, error: { code: 'denied', message: 'the write was denied' } });
			expect(missing).toEqual(forbidden);

			const rowB = await db(api)(TENANT_COLLECTION).where({ id: api.rowIds.b });
			expect(rowB[0]?.title).toBe('Beta record');
		}, 60000);

		test('records activity and a revision for user and full-access writes on a tracked collection', async ({
			confined: api,
		}) => {
			const [tenantAUser] = await db(api)('directus_users')
				.where({ email: 'confined-tenant-a@example.com' })
				.select('id');

			const userCreate = await runOperation(
				api,
				'currentUser',
				{ action: 'createOne', collection: TENANT_COLLECTION, payload: { tenant_id: 'A', title: 'w10-user' } },
				TENANT_A_TOKEN
			);

			expect(userCreate.ok).toBe(true);
			const userKey = String((userCreate as { value: number | string }).value);

			const userActivity = await db(api)('directus_activity').where({
				collection: TENANT_COLLECTION,
				item: userKey,
				action: 'create',
			});

			expect(userActivity).toHaveLength(1);
			expect(userActivity[0]?.user).toBe((tenantAUser as { id: string }).id);

			expect(await db(api)('directus_revisions').where({ collection: TENANT_COLLECTION, item: userKey })).toHaveLength(
				1
			);

			const systemCreate = await runOperation(api, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'A', title: 'w10-system' },
			});

			expect(systemCreate.ok).toBe(true);
			const systemKey = String((systemCreate as { value: number | string }).value);

			const systemActivity = await db(api)('directus_activity').where({
				collection: TENANT_COLLECTION,
				item: systemKey,
				action: 'create',
			});

			expect(systemActivity).toHaveLength(1);
			expect(systemActivity[0]?.user).toBeNull();

			expect(
				await db(api)('directus_revisions').where({ collection: TENANT_COLLECTION, item: systemKey })
			).toHaveLength(1);
		}, 60000);

		test('records neither activity nor a revision on an accountability-off collection', async ({ confined: api }) => {
			const create = await runOperation(api, 'system', {
				action: 'createOne',
				collection: QUARANTINE_COLLECTION,
				payload: { note: 'w11-quarantine' },
			});

			expect(create.ok).toBe(true);
			const key = String((create as { value: number | string }).value);

			expect(await db(api)('directus_activity').where({ collection: QUARANTINE_COLLECTION, item: key })).toHaveLength(
				0
			);

			expect(await db(api)('directus_revisions').where({ collection: QUARANTINE_COLLECTION, item: key })).toHaveLength(
				0
			);
		}, 60000);

		test('preserves the platform validation floor on a nested preset despite an operator null-validation row', async ({
			confined: api,
		}) => {
			const [appRole] = await db(api)('directus_roles').where({ name: 'Confined Tenant App' }).select('id');

			const presetPermission = await db(api)('directus_permissions').where({
				role: (appRole as { id: string }).id,
				collection: 'directus_presets',
				action: 'create',
			});

			expect(presetPermission).toHaveLength(1);
			expect(presetPermission[0]?.validation).toBeNull();

			const [appUser] = await db(api)('directus_users')
				.where({ email: 'confined-tenant-app@example.com' })
				.select('id');

			const [otherUser] = await db(api)('directus_users')
				.where({ email: 'confined-tenant-a@example.com' })
				.select('id');

			const appUserId = (appUser as { id: string }).id;
			const otherUserId = (otherUser as { id: string }).id;

			const allowedBefore = await db(api)('directus_presets').where({ bookmark: 'w5-allowed' });

			const allowed = await runOperation(
				api,
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
			expect(await db(api)(TENANT_COLLECTION).where({ title: 'w5-allowed' })).toHaveLength(1);

			expect(await db(api)('directus_presets').where({ bookmark: 'w5-allowed' })).toHaveLength(
				allowedBefore.length + 1
			);

			const rejectedBefore = await db(api)('directus_presets').where({ bookmark: 'w5-floor' });

			const rejected = await runOperation(
				api,
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

			expect(await db(api)(TENANT_COLLECTION).where({ title: 'w5-floor' })).toHaveLength(0);
			expect(await db(api)('directus_presets').where({ bookmark: 'w5-floor' })).toHaveLength(rejectedBefore.length);
		}, 60000);

		test('applies the create filter and fires the operator action flow on a committed write', async ({
			confined: api,
			actionFlow,
		}) => {
			void actionFlow;

			const create = await runOperation(api, 'system', {
				action: 'createOne',
				collection: TENANT_COLLECTION,
				payload: { tenant_id: 'A', title: 'canary-modify', probe_tag: 'w8' },
			});

			expect(create.ok).toBe(true);
			const key = (create as { value: number | string }).value;

			const rows = await db(api)(TENANT_COLLECTION).where({ id: key });
			expect(rows[0]?.public_body).toBe('canary-touched');

			expect(await waitForCanaryEvent(api, 'w8')).toBe(true);
		}, 60000);

		test('fires parent and child action events for a committed graph but none for a rolled-back one', async ({
			confined: api,
			actionFlow,
		}) => {
			void actionFlow;
			const limit = api.maxBatchMutation;

			const controlStarted = performance.now();

			const control = await runOperation(api, 'system', {
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
			expect(await waitForCanaryEvent(api, 'w9c-parent')).toBe(true);
			expect(await waitForCanaryEvent(api, 'w9c-child')).toBe(true);

			const observedLatency = performance.now() - controlStarted;
			// Action handlers are fire-and-forget, so settle against the observed control latency.
			const settle = () => sleep(Math.min(observedLatency * 3 + 1000, 15000));

			const permissionRollback = await runOperation(
				api,
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

			const ceilingRollback = await runOperation(api, 'system', {
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
				expect(await db(api)(CANARY_COLLECTION).where({ event: tag })).toHaveLength(0);
			}

			expect(await db(api)(TENANT_COLLECTION).whereIn('title', ['w9-perm', 'w9-ceiling'])).toHaveLength(0);
			expect(await db(api)(CHILD_COLLECTION).whereIn('probe_tag', ['w9perm-child', 'w9ceil-child'])).toHaveLength(0);
		}, 120000);
	});
});
