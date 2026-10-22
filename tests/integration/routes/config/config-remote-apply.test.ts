import type { DeepPartial, Field, PermissionsAction, Type } from '@cairncms/types';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dump as dumpYaml } from 'js-yaml';
import path from 'path';
import { expect, vi } from 'vitest';
import { createApiTest, type Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createApiTest({
	env: { LOG_STYLE: 'raw', LOG_LEVEL: 'info' },
	extensions: ['cairncms-extension-settings-fixture'],
});

initializeFixtures();

type Document = Record<string, any>;

const EXT_SUBJECT = 'cairncms-extension-settings-fixture';

const RUN_EVENT = 'config.run.finished';
const NOT_RUN = { folders: 'not_run', schema: 'not_run', configuration: 'not_run' };

function suffix(): string {
	return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function snapshot(api: Api, resources: string[]): Promise<Document> {
	const response = await request(api.url)
		.get('/config/snapshot')
		.query({ manifest_version: '3', resources: resources.join(',') })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
	return response.body.data;
}

type ApplyOptions = {
	dryRun?: boolean;
	destructive?: boolean;
	forceSchema?: string;
	step?: string | string[];
};

function applyConfig(api: Api, desired: Document, options: ApplyOptions = {}) {
	const req = request(api.url)
		.post('/config/apply')
		.set('Authorization', `Bearer ${api.adminToken}`)
		.set('Content-Type', 'application/json');

	const query: Record<string, unknown> = {};
	if (options.dryRun) query['dry_run'] = 'true';
	if (options.destructive) query['destructive'] = 'true';
	if (options.forceSchema !== undefined) query['force_schema'] = options.forceSchema;
	if (options.step !== undefined) query['step'] = options.step;
	if (Object.keys(query).length > 0) req.query(query);

	return req.send(desired);
}

function errorCode(response: { body: { errors?: Array<{ extensions?: { code?: string } }> } }): string | undefined {
	return response.body.errors?.[0]?.extensions?.code;
}

async function tableExists(api: Api, collection: string): Promise<boolean> {
	return api.database.schema.hasTable(collection);
}

type SchemaFieldFixture = {
	collection: string;
	field: string;
	type: Type;
	meta: DeepPartial<Field['meta']> | null;
	schema: DeepPartial<NonNullable<Field['schema']>>;
};

type SchemaCollectionFixture = {
	collection: string;
	meta: null;
	schema: { name: string };
	fields: SchemaFieldFixture[];
	relations: unknown[];
};

type RoleFixture = { key: string; name: string; admin_access: boolean; app_access: boolean };

type PermissionSetFixture = {
	role: string;
	permissions: Array<{
		collection: string;
		action: PermissionsAction;
		permissions: null;
		validation: null;
		presets: null;
		fields: string[];
	}>;
};

type ExtensionSettingFixture = {
	subject: string;
	global: Record<string, unknown>;
	collections: Record<string, Record<string, unknown>>;
};

function newCollection(collection: string): SchemaCollectionFixture {
	return {
		collection,
		meta: null,
		schema: { name: collection },
		fields: [
			{
				collection,
				field: 'id',
				type: 'integer',
				meta: null,
				schema: {
					name: 'id',
					table: collection,
					data_type: 'integer',
					is_nullable: false,
					is_primary_key: true,
					has_auto_increment: true,
				},
			},
		],
		relations: [],
	};
}

function collectionWithFolderField(collection: string, folderKey: string): SchemaCollectionFixture {
	const document = newCollection(collection);

	document.fields.push({
		collection,
		field: 'cover',
		type: 'uuid',
		meta: { interface: 'file', options: { folder: folderKey } },
		schema: { name: 'cover', table: collection, data_type: 'uuid' },
	});

	return document;
}

function appRole(key: string): RoleFixture {
	return { key, name: key, admin_access: false, app_access: true };
}

function readPermissionSet(role: string, collection: string): PermissionSetFixture {
	return {
		role,
		permissions: [{ collection, action: 'read', permissions: null, validation: null, presets: null, fields: ['id'] }],
	};
}

function collectionPreviewSetting(collection: string): ExtensionSettingFixture {
	return { subject: EXT_SUBJECT, global: {}, collections: { [collection]: { preview_url: 'https://example.test' } } };
}

function runRecords(logs: string, runId: string): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];

	for (const line of logs.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		try {
			const parsed = JSON.parse(trimmed);
			if (parsed?.event === RUN_EVENT && parsed?.runId === runId) records.push(parsed);
		} catch {
			// not a structured record line
		}
	}

	return records;
}

async function recordsFor(api: Api, runId: string): Promise<Array<Record<string, unknown>>> {
	return vi.waitFor(
		async () => {
			const found = runRecords(await api.readLogs(), runId);
			if (found.length === 0) throw new Error('config run record not written yet');
			return found;
		},
		{ timeout: 10_000, interval: 100 }
	);
}

async function roleExists(api: Api, key: string): Promise<boolean> {
	return Boolean(await api.database('directus_roles').where({ key }).first());
}

async function permissionExists(api: Api, collection: string): Promise<boolean> {
	return Boolean(await api.database('directus_permissions').where({ collection }).first());
}

async function collectionSettingExists(api: Api, subject: string, collection: string, key: string): Promise<boolean> {
	const row = await api
		.database('cairncms_extension_settings')
		.where({ extension: subject, scope: 'collection', scope_key: collection, key })
		.first();

	return Boolean(row);
}

async function dropCollection(api: Api, collection: string): Promise<void> {
	const present =
		Boolean(await api.database('directus_collections').where({ collection }).first()) ||
		(await api.database.schema.hasTable(collection));

	if (present)
		await setupRequest(api.url).delete(`/collections/${collection}`).auth(api.adminToken, { type: 'bearer' });

	await api.database('directus_fields').where({ collection }).delete();
	await api.database('directus_permissions').where({ collection }).delete();
}

async function deleteRoleByKey(api: Api, key: string): Promise<void> {
	const role = await api.database('directus_roles').where({ key }).first();
	if (role) await setupRequest(api.url).delete(`/roles/${role.id}`).auth(api.adminToken, { type: 'bearer' });
}

async function resetExtensionSettings(api: Api, subject: string): Promise<void> {
	await api.database('cairncms_extension_settings').where({ extension: subject }).delete();
}

test('refuses a schema tree over HTTP that records no provenance, on dry-run and apply', async ({ api }) => {
	const created = `prov_missing_${suffix()}`;
	const roleKey = `prov_role_${suffix()}`;
	const desired = await snapshot(api, ['schema', 'roles']);
	desired['schema'].push(newCollection(created));
	// The role is a pending configuration write that a sound preflight refusal must leave unapplied.
	desired['roles'].push(appRole(roleKey));
	delete desired['manifest']['schema'];

	try {
		const dry = await applyConfig(api, desired, { dryRun: true });
		expect(dry.statusCode).toBe(400);
		expect(errorCode(dry)).toBe('CONFIG_SCHEMA_SOURCE');

		const applied = await applyConfig(api, desired);
		expect(applied.statusCode).toBe(400);
		expect(errorCode(applied)).toBe('CONFIG_SCHEMA_SOURCE');
		expect(applied.body.errors[0].extensions.steps).toEqual(NOT_RUN);
		expect(await roleExists(api, roleKey)).toBe(false);

		const records = await recordsFor(api, applied.headers['x-config-run-id']);
		expect(records).toHaveLength(1);
		expect(records[0]!['result']).toBe('refused');
		expect(records[0]!['steps']).toEqual(NOT_RUN);
		expect(records[0]).not.toHaveProperty('failure');
	} finally {
		await deleteRoleByKey(api, roleKey);
	}
});

test('refuses a schema tree whose recorded release does not match this instance', async ({ api }) => {
	const created = `prov_mismatch_${suffix()}`;
	const desired = await snapshot(api, ['schema']);
	desired['schema'].push(newCollection(created));
	// Keep the captured vendor so only the release differs; a vendor mismatch would mask the release check.
	desired['manifest']['schema'] = { ...desired['manifest']['schema'], release: '0.0.0-not-this-instance' };

	const applied = await applyConfig(api, desired);
	expect(applied.statusCode).toBe(400);
	expect(errorCode(applied)).toBe('CONFIG_SCHEMA_SOURCE');
});

test('rejects a malformed provenance block even when the schema override is passed', async ({ api }) => {
	const desired = await snapshot(api, ['schema']);
	desired['schema'].push(newCollection(`prov_malformed_${suffix()}`));
	desired['manifest']['schema'] = { release: 'present-but-no-vendor' };

	const applied = await applyConfig(api, desired, { forceSchema: 'true' });
	expect(applied.statusCode).toBe(400);
	expect(errorCode(applied)).toBe('CONFIG_INVALID');
});

test('the schema override waives the provenance check and the configuration step applies no schema', async ({
	api,
}) => {
	const created = `prov_override_${suffix()}`;
	const desired = await snapshot(api, ['schema']);
	desired['schema'].push(newCollection(created));
	desired['manifest']['schema'] = { release: '0.0.0-not-this-instance', vendor: 'wrong-vendor' };

	const applied = await applyConfig(api, desired, { forceSchema: 'true' });
	expect(applied.statusCode).toBe(200);
	expect(applied.body.meta.result).toBe('no_changes');
	expect(applied.body.meta.steps).toEqual({ folders: 'not_run', schema: 'not_run', configuration: 'skipped' });

	expect(await tableExists(api, created)).toBe(false);
});

test('refuses a schema folder reference absent from the target and the managed folders', async ({ api }) => {
	const created = `ref_${suffix()}`;
	const ghost = `ghost_${suffix()}`;
	const roleKey = `ref_role_${suffix()}`;
	const desired = await snapshot(api, ['schema', 'folders', 'roles']);
	desired['schema'].push(collectionWithFolderField(created, ghost));
	desired['roles'].push(appRole(roleKey));

	try {
		const dry = await applyConfig(api, desired, { dryRun: true, forceSchema: 'true' });
		expect(dry.statusCode).toBe(400);
		expect(errorCode(dry)).toBe('CONFIG_INVALID');
		expect(dry.body.errors[0].message).toContain(ghost);

		const applied = await applyConfig(api, desired, { forceSchema: 'true' });
		expect(applied.statusCode).toBe(400);
		expect(errorCode(applied)).toBe('CONFIG_INVALID');
		expect(applied.body.errors[0].message).toContain(ghost);
		expect(await roleExists(api, roleKey)).toBe(false);
	} finally {
		await deleteRoleByKey(api, roleKey);
	}
});

test('applies a non-schema kind over HTTP after the CLI has created the schema', async ({ api }) => {
	const created = `after_schema_${suffix()}`;
	const roleKey = `role_${suffix()}`;
	const committed = { folders: 'not_run', schema: 'not_run', configuration: 'committed' };

	try {
		const fixtureRoot = await fs.mkdtemp(path.join(api.directory, 'remote-apply-'));
		await fs.writeFile(path.join(fixtureRoot, 'cairncms-config.yaml'), dumpYaml({ version: 3, resources: ['schema'] }));
		expect((await api.cli(['config', 'snapshot', fixtureRoot, '--yes'])).status).toBe(0);

		await fs.mkdir(path.join(fixtureRoot, 'schema'), { recursive: true });
		await fs.writeFile(path.join(fixtureRoot, 'schema', `${created}.yaml`), dumpYaml(newCollection(created)));
		expect((await api.cli(['config', 'apply', fixtureRoot, '--yes'])).status).toBe(0);
		expect(await tableExists(api, created)).toBe(true);

		const desired = await snapshot(api, ['schema', 'roles', 'extension-settings']);
		desired['roles'].push(appRole(roleKey));

		// The collection-scoped setting for the now-existing collection is the success control for the out-of-order refusal.
		desired['extension-settings'] = [
			...desired['extension-settings'].filter((entry: Document) => entry.subject !== EXT_SUBJECT),
			collectionPreviewSetting(created),
		];

		const applied = await applyConfig(api, desired);
		expect(applied.statusCode).toBe(200);
		expect(applied.body.meta.result).toBe('applied');
		expect(applied.body.meta.steps).toEqual(committed);

		expect(await roleExists(api, roleKey)).toBe(true);
		expect(await collectionSettingExists(api, EXT_SUBJECT, created, 'preview_url')).toBe(true);

		const records = await recordsFor(api, applied.headers['x-config-run-id']);
		expect(records).toHaveLength(1);
		expect(records[0]!['result']).toBe('applied');
		expect(records[0]!['steps']).toEqual(committed);
	} finally {
		await resetExtensionSettings(api, EXT_SUBJECT);
		await deleteRoleByKey(api, roleKey);
		await dropCollection(api, created);
	}
});

test('refuses a collection-scoped extension setting for a collection the configuration step cannot see', async ({
	api,
}) => {
	const created = `ext_oos_${suffix()}`;
	const roleKey = `ext_role_${suffix()}`;
	const desired = await snapshot(api, ['schema', 'extension-settings', 'roles']);
	desired['schema'].push(newCollection(created));
	desired['roles'].push(appRole(roleKey));

	desired['extension-settings'] = [
		...desired['extension-settings'].filter((entry: Document) => entry.subject !== EXT_SUBJECT),
		collectionPreviewSetting(created),
	];

	try {
		const applied = await applyConfig(api, desired, { forceSchema: 'true' });
		expect(applied.statusCode).toBe(400);
		expect(errorCode(applied)).toBe('CONFIG_INVALID');
		expect(applied.body.errors[0].message).toContain(created);
		expect(await roleExists(api, roleKey)).toBe(false);
	} finally {
		await resetExtensionSettings(api, EXT_SUBJECT);
		await deleteRoleByKey(api, roleKey);
	}
});

test('allows a permission for a collection the configuration step cannot see', async ({ api }) => {
	const created = `perm_oos_${suffix()}`;
	const roleKey = `perm_role_${suffix()}`;

	try {
		const desired = await snapshot(api, ['schema', 'roles', 'permissions']);
		desired['schema'].push(newCollection(created));
		desired['roles'].push(appRole(roleKey));
		desired['permissions'].push(readPermissionSet(roleKey, created));

		const applied = await applyConfig(api, desired, { forceSchema: 'true' });
		expect(applied.statusCode).toBe(200);
		expect(applied.body.meta.result).toBe('applied');

		expect(await roleExists(api, roleKey)).toBe(true);
		expect(await permissionExists(api, created)).toBe(true);
		expect(await tableExists(api, created)).toBe(false);
	} finally {
		await deleteRoleByKey(api, roleKey);
		await dropCollection(api, created);
	}
});

test('refuses an unrecognized step, a repeated step, and a non-boolean force_schema', async ({ api }) => {
	const desired = await snapshot(api, ['roles']);

	const unknownStep = await applyConfig(api, desired, { step: 'folders' });
	expect(unknownStep.statusCode).toBe(400);
	expect(errorCode(unknownStep)).toBe('CONFIG_INVALID');

	const repeatedStep = await applyConfig(api, desired, { step: ['folders', 'schema'] });
	expect(repeatedStep.statusCode).toBe(400);
	expect(errorCode(repeatedStep)).toBe('CONFIG_INVALID');

	const badForce = await applyConfig(api, desired, { forceSchema: 'maybe' });
	expect(badForce.statusCode).toBe(400);
	expect(errorCode(badForce)).toBe('CONFIG_INVALID');
});
