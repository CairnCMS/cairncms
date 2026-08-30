import request from 'supertest';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import config, { getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import type { Filter } from '@cairncms/types';
import * as common from '@common/index';
import knex, { type Knex } from 'knex';

type ConfigSnapshot = {
	manifest: { version: number; resources: string[] };
	roles: Array<Record<string, any>>;
	permissions: Array<{ role: string; permissions: Array<Record<string, any>> }>;
};

const baselineCache: Record<string, ConfigSnapshot> = {};

async function getBaseline(vendor: string): Promise<ConfigSnapshot> {
	if (!baselineCache[vendor]) {
		const response = await request(getUrl(vendor))
			.get('/config/snapshot')
			.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

		expect(response.statusCode).toBe(200);
		baselineCache[vendor] = response.body.data;
	}

	return JSON.parse(JSON.stringify(baselineCache[vendor]!)) as ConfigSnapshot;
}

async function applyConfig(
	vendor: string,
	desired: unknown,
	options: { destructive?: boolean; dryRun?: boolean } = {}
) {
	const req = request(getUrl(vendor))
		.post('/config/apply')
		.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
		.set('Content-Type', 'application/json');

	if (options.destructive) req.query({ destructive: 'true' });
	if (options.dryRun) req.query({ dry_run: 'true' });

	return req.send(desired as object);
}

async function resetToBaseline(vendor: string): Promise<void> {
	const baseline = await getBaseline(vendor);
	const response = await applyConfig(vendor, baseline, { destructive: true });
	expect(response.statusCode).toBe(200);
}

async function adminSnapshot(vendor: string): Promise<ConfigSnapshot> {
	const response = await request(getUrl(vendor))
		.get('/config/snapshot')
		.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

	expect(response.statusCode).toBe(200);
	return response.body.data as ConfigSnapshot;
}

function errorMessages(response: { body: { errors?: unknown } }): string[] {
	const errors = response.body.errors;
	if (!Array.isArray(errors)) return [];
	return errors.map((error: unknown) =>
		typeof error === 'string' ? error : String((error as { message?: unknown }).message ?? '')
	);
}

/** Uses canonical filter grammar so only the guard under test can reject the fixture. */
function setPublicFilter(snapshot: ConfigSnapshot, filter: Filter): void {
	const permission = {
		collection: 'directus_files',
		action: 'read',
		permissions: filter,
		validation: null,
		presets: null,
		fields: ['*'],
	};

	const publicSet = snapshot.permissions.find((set) => set.role === 'public');

	if (publicSet) {
		publicSet.permissions.push(permission);
	} else {
		snapshot.permissions.push({ role: 'public', permissions: [permission] });
	}
}

describe('Config-as-Code API', () => {
	describe('GET /config/snapshot', () => {
		describe('denies non-admin users', () => {
			it.each(vendors)('%s', async (vendor) => {
				const noAuth = await request(getUrl(vendor)).get('/config/snapshot');
				expect(noAuth.statusCode).toBe(403);

				const invalid = await request(getUrl(vendor))
					.get('/config/snapshot')
					.set('Authorization', 'Bearer invalid-token');

				expect(invalid.statusCode).toBe(401);

				for (const userKey of ['APP_ACCESS', 'API_ONLY', 'NO_ROLE'] as const) {
					const response = await request(getUrl(vendor))
						.get('/config/snapshot')
						.set('Authorization', `Bearer ${common.USER[userKey]!.TOKEN}`);

					expect(response.statusCode).toBe(403);
				}
			});
		});

		describe('returns snapshot (JSON) for admin', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.get('/config/snapshot')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

				expect(response.statusCode).toBe(200);
				expect(response.body).toHaveProperty('data');
				expect(response.body.data).toHaveProperty('manifest');
				expect(response.body.data).toHaveProperty('roles');
				expect(response.body.data).toHaveProperty('permissions');
				expect(response.body.data.manifest.version).toBe(1);
				expect(Array.isArray(response.body.data.roles)).toBe(true);
				expect(Array.isArray(response.body.data.permissions)).toBe(true);
			});
		});

		describe('returns snapshot as YAML', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.get('/config/snapshot')
					.query({ export: 'yaml' })
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

				expect(response.statusCode).toBe(200);
				expect(response.headers['content-type']).toContain('text/yaml');

				const parsed = loadYaml(response.text) as ConfigSnapshot;
				expect(parsed.manifest.version).toBe(1);
				expect(Array.isArray(parsed.roles)).toBe(true);
				expect(Array.isArray(parsed.permissions)).toBe(true);
			});
		});
	});

	describe('POST /config/apply', () => {
		describe('denies non-admin users', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);

				const noAuth = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Content-Type', 'application/json')
					.send(baseline);

				expect(noAuth.statusCode).toBe(403);

				const invalid = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', 'Bearer invalid-token')
					.set('Content-Type', 'application/json')
					.send(baseline);

				expect(invalid.statusCode).toBe(401);

				for (const userKey of ['APP_ACCESS', 'API_ONLY', 'NO_ROLE'] as const) {
					const response = await request(getUrl(vendor))
						.post('/config/apply')
						.set('Authorization', `Bearer ${common.USER[userKey]!.TOKEN}`)
						.set('Content-Type', 'application/json')
						.send(baseline);

					expect(response.statusCode).toBe(403);
				}
			});
		});

		describe('applies baseline snapshot with no drift (JSON)', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const response = await applyConfig(vendor, baseline);

				expect(response.statusCode).toBe(200);
				expect(response.body.data.roles.created).toEqual([]);
				expect(response.body.data.roles.updated).toEqual([]);
				expect(response.body.data.roles.deleted).toEqual([]);
				expect(response.body.data.permissions.created).toBe(0);
				expect(response.body.data.permissions.updated).toBe(0);
				expect(response.body.data.permissions.deleted).toBe(0);
			});
		});

		describe('applies baseline snapshot with no drift (YAML)', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const yaml = dumpYaml(baseline);

				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'text/yaml')
					.send(yaml);

				expect(response.statusCode).toBe(200);
				expect(response.body.data.roles.created).toEqual([]);
				expect(response.body.data.roles.updated).toEqual([]);
			});
		});

		describe('?dry_run=true does not mutate', () => {
			it.each(vendors)('%s', async (vendor) => {
				const before = await adminSnapshot(vendor);
				const desired = JSON.parse(JSON.stringify(before)) as ConfigSnapshot;
				const probeKey = `dryrun_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;

				desired.roles.push({
					key: probeKey,
					name: 'Dry Run Probe',
					admin_access: false,
					app_access: true,
				});

				try {
					const dry = await applyConfig(vendor, desired, { dryRun: true });

					expect(dry.statusCode).toBe(200);

					expect(
						dry.body.data.changes.filter(
							(change: any) =>
								change.kind === 'roles' && change.operation === 'create' && change.identity.key === probeKey
						)
					).toHaveLength(1);

					expect(await adminSnapshot(vendor)).toEqual(before);
				} finally {
					await resetToBaseline(vendor);
				}
			});
		});

		describe('?destructive=true removes orphan roles', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const orphanKey = `orphan_destructive_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;

				const desiredCreate = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

				desiredCreate.roles.push({
					key: orphanKey,
					name: 'Orphan Destructive',
					admin_access: false,
					app_access: true,
				});

				try {
					const create = await applyConfig(vendor, desiredCreate);
					expect(create.statusCode).toBe(200);
					expect(create.body.data.roles.created).toContain(orphanKey);

					const destructive = await applyConfig(vendor, baseline, { destructive: true });
					expect(destructive.statusCode).toBe(200);
					expect(destructive.body.data.roles.deleted).toContain(orphanKey);

					const snap = await request(getUrl(vendor))
						.get('/config/snapshot')
						.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

					expect(snap.body.data.roles.find((r: any) => r.key === orphanKey)).toBeUndefined();
				} finally {
					await resetToBaseline(vendor);
				}
			});
		});

		describe('rejects malformed JSON', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send('not json {');

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
			});
		});

		describe('rejects malformed YAML', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'text/yaml')
					.send('manifest: [: not valid');

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(response.body.errors[0].message).toContain('could not be parsed');
			});
		});

		describe('does not echo the offending source line when YAML fails to parse', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'text/yaml')
					.send('manifest: {version: 1, resources: []}\ntoken: "s3cret-probe-value\n');

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(JSON.stringify(response.body)).not.toContain('s3cret-probe-value');
			});
		});

		describe('rejects a YAML filter value that cannot be stored without silent change', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				setPublicFilter(baseline, { filesize: { _eq: '__NON_FINITE__' } });
				const yaml = dumpYaml(baseline).replace('__NON_FINITE__', '.inf');

				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.query({ dry_run: 'true' })
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'text/yaml')
					.send(yaml);

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(response.body.errors[0].message).toContain('cannot be stored');
				expect(response.body.errors[0].message).toContain('filesize');
			});
		});

		describe('rejects a JSON filter nested past the supported depth', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);

				let nested: Filter = { id: { _eq: 'probe' } };
				for (let level = 0; level < 150; level++) nested = { _and: [nested] };
				setPublicFilter(baseline, nested);

				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.query({ dry_run: 'true' })
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send(baseline);

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(response.body.errors[0].message).toContain('nesting is deeper than');
			});
		});

		describe('rejects placeholder syntax and stores nothing', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);

				baseline.roles.push({
					key: 'probe_placeholder',
					name: '{{CAIRNCMS_CONFIG_ROLE_NAME}}',
					admin_access: false,
					app_access: true,
				});

				try {
					const response = await applyConfig(vendor, baseline);

					expect(response.statusCode).toBe(400);
					expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
					expect(response.body.errors[0].message).toContain('placeholder syntax');

					const snapshot = await request(getUrl(vendor))
						.get('/config/snapshot')
						.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

					expect(snapshot.statusCode).toBe(200);
					expect(snapshot.body.data.roles.find((r: any) => r.key === 'probe_placeholder')).toBeUndefined();
				} finally {
					await resetToBaseline(vendor);
				}
			});
		});

		describe('rejects unsupported Content-Type', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'text/plain')
					.send('hello');

				expect(response.statusCode).toBe(415);
				expect(response.body.errors[0].extensions.code).toBe('UNSUPPORTED_MEDIA_TYPE');
			});
		});

		describe('structural guard rejects malformed shapes', () => {
			it.each(vendors)('%s null role entries', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send({
						manifest: { version: 1, resources: ['roles', 'permissions'] },
						roles: [null],
						permissions: [],
					});

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(response.body.errors[0].message).toContain('roles[0]');
			});

			it.each(vendors)('%s permission set with non-array permissions', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send({
						manifest: { version: 1, resources: ['roles', 'permissions'] },
						roles: [],
						permissions: [{ role: 'x', permissions: null }],
					});

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(response.body.errors[0].message).toContain('permissions[0].permissions');
			});

			it.each(vendors)('%s role with non-string key', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send({
						manifest: { version: 1, resources: ['roles', 'permissions'] },
						roles: [{ key: 1 }],
						permissions: [],
					});

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
				expect(response.body.errors[0].message).toContain('roles[0]');
				expect(response.body.errors[0].message).toContain('key');
			});
		});

		describe('rejects an unsupported manifest version with a typed code', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await request(getUrl(vendor))
					.post('/config/apply')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send({
						manifest: { version: 99, resources: ['roles', 'permissions'] },
						roles: [],
						permissions: [],
					});

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_UNSUPPORTED_VERSION');
				expect(response.body.errors[0].message).toContain('version 99');
			});
		});

		describe('rejects a duplicate permission tuple as a typed identity conflict', () => {
			it.each(vendors)('%s', async (vendor) => {
				const desired = await getBaseline(vendor);

				const duplicate = {
					collection: 'directus_files',
					action: 'update',
					permissions: null,
					validation: null,
					presets: null,
					fields: ['*'],
				};

				const publicSet = desired.permissions.find((set) => set.role === 'public');

				if (publicSet) {
					publicSet.permissions.push({ ...duplicate }, { ...duplicate });
				} else {
					desired.permissions.push({ role: 'public', permissions: [{ ...duplicate }, { ...duplicate }] });
				}

				const response = await applyConfig(vendor, desired, { dryRun: true });

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_IDENTITY_CONFLICT');
				expect(errorMessages(response).some((message) => message.includes('Duplicate permission'))).toBe(true);
			});
		});

		describe('refuses to delete the last admin role as a protected record', () => {
			it.each(vendors)('%s', async (vendor) => {
				const before = await adminSnapshot(vendor);

				const desired = JSON.parse(JSON.stringify(before)) as ConfigSnapshot;

				const adminKeys = desired.roles.filter((role) => role.admin_access === true).map((role) => role.key);
				expect(adminKeys.length).toBeGreaterThan(0);

				desired.roles = desired.roles.filter((role) => role.admin_access !== true);
				desired.permissions = desired.permissions.filter((set) => !adminKeys.includes(set.role));

				const response = await applyConfig(vendor, desired, { dryRun: true });

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('CONFIG_PROTECTED_RECORD');
				expect(errorMessages(response).some((message) => message.includes('admin role'))).toBe(true);

				const after = await adminSnapshot(vendor);

				expect(after).toEqual(before);
			});
		});

		describe('a non-destructive mutating apply with deletions is refused', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
				const orphanKey = `refuse_orphan_${suffix}`;
				const updateKey = `refuse_update_${suffix}`;
				const newKey = `refuse_new_${suffix}`;

				const withProbes = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

				withProbes.roles.push(
					{ key: orphanKey, name: 'Refuse Orphan', admin_access: false, app_access: true },
					{ key: updateKey, name: 'Refuse Update', description: 'update-before', admin_access: false, app_access: true }
				);

				try {
					expect((await applyConfig(vendor, withProbes)).statusCode).toBe(200);

					const afterSetup = await adminSnapshot(vendor);

					const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

					desired.roles.push(
						{ key: newKey, name: 'Refuse New', admin_access: false, app_access: true },
						{
							key: updateKey,
							name: 'Refuse Update',
							description: 'update-after',
							admin_access: false,
							app_access: true,
						}
					);

					const response = await applyConfig(vendor, desired);

					expect(response.statusCode).toBe(400);
					expect(response.body.errors[0].extensions.code).toBe('DESTRUCTIVE_CHANGES_REQUIRED');

					expect(response.body.errors[0].extensions.deletions).toEqual([
						{ kind: 'roles', identity: { key: orphanKey } },
					]);

					const after = await adminSnapshot(vendor);

					expect(after).toEqual(afterSetup);
				} finally {
					await resetToBaseline(vendor);
				}
			});
		});

		describe('an empty dry run returns the complete plan document', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const response = await applyConfig(vendor, baseline, { dryRun: true });

				expect(response.statusCode).toBe(200);

				expect(response.body.data).toEqual({
					planVersion: 1,
					manifestVersion: 1,
					changes: [],
					summary: { create: 0, update: 0, delete: 0 },
					warnings: [],
				});
			});
		});

		describe('a permission for a missing collection applies and warns', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const collection = `missing_coll_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;
				const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

				const perm = { collection, action: 'read', permissions: null, validation: null, presets: null, fields: ['*'] };
				const publicSet = desired.permissions.find((set) => set.role === 'public');
				if (publicSet) publicSet.permissions.push(perm);
				else desired.permissions.push({ role: 'public', permissions: [perm] });

				try {
					const dry = await applyConfig(vendor, desired, { dryRun: true });
					expect(dry.statusCode).toBe(200);

					expect(dry.body.data.warnings).toEqual([
						{
							code: 'COLLECTION_MISSING',
							kind: 'permissions',
							identity: { role: 'public', collection, action: 'read' },
							message: expect.stringContaining(collection),
						},
					]);

					const apply = await applyConfig(vendor, desired);
					expect(apply.statusCode).toBe(200);
					expect(apply.body.data.permissions.created).toBe(1);

					const snap = await request(getUrl(vendor))
						.get('/config/snapshot')
						.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

					expect(snap.statusCode).toBe(200);

					const pub = snap.body.data.permissions.find((set: any) => set.role === 'public');

					expect(pub.permissions.find((p: any) => p.collection === collection)).toEqual({
						collection,
						action: 'read',
						permissions: null,
						validation: null,
						presets: null,
						fields: ['*'],
					});
				} finally {
					await resetToBaseline(vendor);
				}
			});
		});

		describe('omit-preserve regression: omitted optional role fields are not cleared', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
				const adminRole = desired.roles.find((r: any) => r.admin_access === true);
				expect(adminRole).toBeDefined();

				const originalIcon = adminRole!['icon'];
				const originalDescription = adminRole!['description'];
				const originalEnforceTfa = adminRole!['enforce_tfa'];

				delete adminRole!['icon'];
				delete adminRole!['description'];
				delete adminRole!['enforce_tfa'];

				const response = await applyConfig(vendor, desired);

				expect(response.statusCode).toBe(200);
				expect(response.body.data.roles.updated).toEqual([]);

				const snap = await request(getUrl(vendor))
					.get('/config/snapshot')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

				const snapAdmin = snap.body.data.roles.find((r: any) => r.admin_access === true);
				expect(snapAdmin.icon).toBe(originalIcon);
				expect(snapAdmin.description).toBe(originalDescription);
				expect(snapAdmin.enforce_tfa).toBe(originalEnforceTfa);
			});
		});

		describe('public role round-trip', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const collection = `pub_test_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;
				const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

				const newPerm = {
					collection,
					action: 'read',
					permissions: null,
					validation: null,
					presets: null,
					fields: ['*'],
				};

				const publicSet = desired.permissions.find((p) => p.role === 'public');

				if (publicSet) {
					publicSet.permissions = publicSet.permissions.filter(
						(p) => !(p['collection'] === collection && p['action'] === 'read')
					);

					publicSet.permissions.push(newPerm);
				} else {
					desired.permissions.push({ role: 'public', permissions: [newPerm] });
				}

				try {
					const apply = await applyConfig(vendor, desired);
					expect(apply.statusCode).toBe(200);
					expect(apply.body.data.permissions.created).toBeGreaterThanOrEqual(1);

					const snap = await request(getUrl(vendor))
						.get('/config/snapshot')
						.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

					const pub = snap.body.data.permissions.find((p: any) => p.role === 'public');
					expect(pub).toBeDefined();
					expect(pub.permissions.find((p: any) => p.collection === collection && p.action === 'read')).toBeDefined();
				} finally {
					await resetToBaseline(vendor);
				}
			});
		});
	});
});

describe('Config-as-Code managed scope', () => {
	function sanitize(vendor: string): string {
		return vendor.replace(/[^a-z0-9_]/gi, '_');
	}

	async function currentSnapshot(vendor: string): Promise<ConfigSnapshot> {
		const response = await request(getUrl(vendor))
			.get('/config/snapshot')
			.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

		expect(response.statusCode).toBe(200);
		return response.body.data as ConfigSnapshot;
	}

	describe('a roles-only destructive apply leaves permissions untouched', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await currentSnapshot(vendor);
			const desired = JSON.parse(JSON.stringify(before)) as ConfigSnapshot;
			desired.manifest = { version: 1, resources: ['roles'] };
			desired.permissions = [];

			try {
				const response = await applyConfig(vendor, desired, { destructive: true });

				expect(response.statusCode).toBe(200);
				expect(response.body.data.roles.deleted).toEqual([]);
				expect(response.body.data.permissions.created).toBe(0);
				expect(response.body.data.permissions.updated).toBe(0);
				expect(response.body.data.permissions.deleted).toBe(0);

				expect(await currentSnapshot(vendor)).toEqual(before);
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});

	describe('an empty managed scope ignores malformed records and changes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await currentSnapshot(vendor);

			try {
				const response = await applyConfig(
					vendor,
					{
						manifest: { version: 1, resources: [] },
						roles: [null, { nonsense: true }],
						permissions: [{ role: 42, permissions: 'not-an-array' }],
					},
					{ destructive: true }
				);

				expect(response.statusCode).toBe(200);
				expect(response.body.data.roles.created).toEqual([]);
				expect(response.body.data.roles.updated).toEqual([]);
				expect(response.body.data.roles.deleted).toEqual([]);
				expect(response.body.data.permissions.created).toBe(0);
				expect(response.body.data.permissions.updated).toBe(0);
				expect(response.body.data.permissions.deleted).toBe(0);

				expect(await currentSnapshot(vendor)).toEqual(before);
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});

	describe('a resources mapping is refused as CONFIG_INVALID and changes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await currentSnapshot(vendor);

			const response = await request(getUrl(vendor))
				.post('/config/apply')
				.query({ dry_run: 'true' })
				.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
				.set('Content-Type', 'application/json')
				.send({ manifest: { version: 1, resources: {} }, roles: [], permissions: [] });

			expect(response.statusCode).toBe(400);
			expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');

			expect(await currentSnapshot(vendor)).toEqual(before);
		});
	});

	describe('a permissions-only apply creates a permission for a role it does not manage', () => {
		it.each(vendors)('%s', async (vendor) => {
			const roleKey = `perm_only_${sanitize(vendor)}`;
			const baseline = await getBaseline(vendor);

			const withRole = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
			withRole.roles.push({ key: roleKey, name: 'Perm Only', admin_access: false, app_access: true });

			try {
				const create = await applyConfig(vendor, withRole);
				expect(create.statusCode).toBe(200);
				expect(create.body.data.roles.created).toContain(roleKey);

				const rolesAfterSetup = (await currentSnapshot(vendor)).roles;

				const permsOnly = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
				permsOnly.manifest = { version: 1, resources: ['permissions'] };
				permsOnly.roles = [];

				permsOnly.permissions.push({
					role: roleKey,
					permissions: [
						{
							collection: 'directus_files',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: ['*'],
						},
					],
				});

				const response = await applyConfig(vendor, permsOnly);

				expect(response.statusCode).toBe(200);
				expect(response.body.data.permissions.created).toBe(1);
				expect(response.body.data.permissions.updated).toBe(0);
				expect(response.body.data.permissions.deleted).toBe(0);

				const final = await currentSnapshot(vendor);
				expect(final.roles).toEqual(rolesAfterSetup);

				const set = final.permissions.find((p) => p.role === roleKey);
				expect(set).toBeDefined();
				expect(set!.permissions.find((p) => p.collection === 'directus_files')).toBeDefined();
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});

	describe('a both-managed apply rejects a permission for a role it does not declare', () => {
		it.each(vendors)('%s', async (vendor) => {
			const roleKey = `ref_probe_${sanitize(vendor)}`;
			const baseline = await getBaseline(vendor);

			const withRole = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
			withRole.roles.push({ key: roleKey, name: 'Ref Probe', admin_access: false, app_access: true });

			try {
				expect((await applyConfig(vendor, withRole)).statusCode).toBe(200);
				const afterCreate = await currentSnapshot(vendor);

				const both = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

				both.permissions.push({
					role: roleKey,
					permissions: [
						{
							collection: 'directus_files',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: ['*'],
						},
					],
				});

				const response = await applyConfig(vendor, both);

				expect(response.statusCode).toBe(400);
				expect(errorMessages(response).some((message) => message.includes(roleKey))).toBe(true);

				expect(await currentSnapshot(vendor)).toEqual(afterCreate);
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});

	describe('an unknown role field is refused', () => {
		it.each(vendors)('%s', async (vendor) => {
			const baseline = await getBaseline(vendor);
			const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

			desired.roles.push({
				key: `unknown_field_${sanitize(vendor)}`,
				name: 'Unknown Field',
				admin_access: false,
				app_access: true,
				bogus_field: true,
			});

			const response = await applyConfig(vendor, desired, { dryRun: true });

			expect(response.statusCode).toBe(400);
			expect(errorMessages(response).some((message) => message.includes('bogus_field'))).toBe(true);
		});
	});
});

describe('cairncms config apply refuses a tree it cannot read', () => {
	let fixtureRoot: string;

	beforeEach(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-cli-'));
	});

	afterEach(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	async function snapshotData(vendor: string): Promise<ConfigSnapshot> {
		const response = await request(getUrl(vendor))
			.get('/config/snapshot')
			.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

		expect(response.statusCode).toBe(200);
		return response.body.data as ConfigSnapshot;
	}

	function expectApplyRefused(vendor: string, diagnostic: string, status: number): void {
		const result = spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'apply', fixtureRoot, '--yes'], {
			cwd: paths.cwd,
			env: config.envs[vendor as keyof typeof config.envs],
			encoding: 'utf8',
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(status);
		expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(diagnostic);
	}

	async function writeManifest(version = 1): Promise<void> {
		await fs.writeFile(
			path.join(fixtureRoot, 'cairncms-config.yaml'),
			dumpYaml({ version, resources: ['roles', 'permissions'] })
		);
	}

	describe('an unsupported manifest version terminates nonzero and writes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await snapshotData(vendor);
			await writeManifest(99);

			expectApplyRefused(vendor, 'declares version 99', 2);
			expect(await snapshotData(vendor)).toEqual(before);
		});
	});

	describe('a managed directory whose link does not resolve terminates nonzero and writes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await snapshotData(vendor);
			await writeManifest();
			await fs.symlink(path.join(fixtureRoot, 'never-created'), path.join(fixtureRoot, 'roles'));

			expectApplyRefused(vendor, 'is a link that does not resolve', 2);
			expect(await snapshotData(vendor)).toEqual(before);
		});
	});

	describe('a placeholder outside the supported namespace terminates nonzero and writes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await snapshotData(vendor);
			await writeManifest();
			await fs.mkdir(path.join(fixtureRoot, 'roles'), { recursive: true });

			await fs.writeFile(
				path.join(fixtureRoot, 'roles', 'cli_probe.yaml'),
				dumpYaml({
					key: 'cli_probe',
					name: '{{DATABASE_PASSWORD}}',
					admin_access: false,
					app_access: true,
				})
			);

			try {
				expectApplyRefused(vendor, 'outside the CAIRNCMS_CONFIG_ namespace', 2);

				const after = await snapshotData(vendor);
				expect(after).toEqual(before);
				expect(after.roles.map((role) => role.key)).not.toContain('cli_probe');
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});

	describe('a role file with an unsupported field terminates nonzero and writes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await snapshotData(vendor);
			await writeManifest();
			await fs.mkdir(path.join(fixtureRoot, 'roles'), { recursive: true });

			await fs.writeFile(
				path.join(fixtureRoot, 'roles', 'cli_unknown.yaml'),
				dumpYaml({
					key: 'cli_unknown',
					name: 'CLI Unknown',
					admin_access: false,
					app_access: true,
					bogus_field: true,
				})
			);

			try {
				expectApplyRefused(vendor, 'bogus_field', 2);

				const after = await snapshotData(vendor);
				expect(after).toEqual(before);
				expect(after.roles.map((role) => role.key)).not.toContain('cli_unknown');
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});
});

describe('cairncms config snapshot preserves managed scope', () => {
	let fixtureRoot: string;

	beforeEach(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-snap-'));
	});

	afterEach(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	function runSnapshot(vendor: string) {
		return spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'snapshot', fixtureRoot, '--yes'], {
			cwd: paths.cwd,
			env: {
				...config.envs[vendor as keyof typeof config.envs],
				LOG_LEVEL: 'info',
				LOG_STYLE: 'raw',
			},
			encoding: 'utf8',
		});
	}

	async function readManifest(): Promise<{ resources: string[] }> {
		return loadYaml(await fs.readFile(path.join(fixtureRoot, 'cairncms-config.yaml'), 'utf8')) as {
			resources: string[];
		};
	}

	describe('snapshotting a roles-only tree keeps it roles-only and leaves permission files untouched', () => {
		it.each(vendors)('%s', async (vendor) => {
			await fs.writeFile(
				path.join(fixtureRoot, 'cairncms-config.yaml'),
				dumpYaml({ version: 1, resources: ['roles'] })
			);

			await fs.mkdir(path.join(fixtureRoot, 'permissions'), { recursive: true });

			const survivor = path.join(fixtureRoot, 'permissions', 'editor.yaml');
			const survivorBody = dumpYaml({ role: 'editor', permissions: [] });
			await fs.writeFile(survivor, survivorBody);
			await fs.writeFile(path.join(fixtureRoot, 'permissions', 'broken.yaml'), 'this: [not, valid');

			const result = runSnapshot(vendor);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect((await readManifest()).resources).toEqual(['roles']);

			const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
			expect(output.match(/Leaving permissions unmanaged/g)?.length ?? 0).toBe(1);

			expect(await fs.readFile(survivor, 'utf8')).toBe(survivorBody);
		});
	});

	describe('snapshotting an empty directory manages every supported kind', () => {
		it.each(vendors)('%s', async (vendor) => {
			const result = runSnapshot(vendor);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect((await readManifest()).resources.slice().sort()).toEqual(['permissions', 'roles']);
		});
	});
});

describe('Config-as-Code stored state', () => {
	const databases = new Map<string, Knex>();
	const PROBE_COLLECTION = 'cairncms_config_stored_state_probe';

	beforeAll(() => {
		for (const vendor of vendors) databases.set(vendor, knex(config.knexConfig[vendor]!));
	});

	afterAll(async () => {
		for (const [, db] of databases) await db.destroy();
	});

	describe('refuses to read a stored filter it cannot interpret', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const role = await db('directus_roles').select('id').first();
			expect(role).toBeDefined();

			// Valid JSON reaches the read path on every vendor; malformed text can fail at the database boundary.
			await db('directus_permissions').insert({
				role: role.id,
				collection: PROBE_COLLECTION,
				action: 'read',
				permissions: '[]',
			});

			try {
				const snapshot = await request(getUrl(vendor))
					.get('/config/snapshot')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

				expect(snapshot.statusCode).toBe(500);
				expect(snapshot.body.errors[0].extensions.code).toBe('CONFIG_READ_FAILED');

				const apply = await request(getUrl(vendor))
					.post('/config/apply')
					.query({ dry_run: 'true' })
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
					.set('Content-Type', 'application/json')
					.send({ manifest: { version: 1, resources: ['roles', 'permissions'] }, roles: [], permissions: [] });

				expect(apply.statusCode).toBe(500);
				expect(apply.body.errors[0].extensions.code).toBe('CONFIG_READ_FAILED');
			} finally {
				await db('directus_permissions').where({ collection: PROBE_COLLECTION }).del();
			}

			const recovered = await request(getUrl(vendor))
				.get('/config/snapshot')
				.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

			expect(recovered.statusCode).toBe(200);
		});
	});
});

describe('Config-as-Code deletion impact', () => {
	const databases = new Map<string, Knex>();
	let fixtureRoot: string;

	beforeAll(() => {
		for (const vendor of vendors) databases.set(vendor, knex(config.knexConfig[vendor]!));
	});

	afterAll(async () => {
		for (const [, db] of databases) await db.destroy();
	});

	beforeEach(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-impact-'));
	});

	afterEach(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	describe('a role deletion reports its cascade impact identically on both surfaces', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const roleKey = `impact_probe_${suffix}_${rand}`;
			const roleId = randomUUID();
			const userId = randomUUID();
			const token = randomUUID().replace(/-/g, '');
			const collection = 'directus_files';
			const bookmark = 'Probe Bookmark';

			const baseline = await getBaseline(vendor);

			const snapshot = spawnSync(
				'node',
				['--no-node-snapshot', paths.cli, 'config', 'snapshot', fixtureRoot, '--yes'],
				{ cwd: paths.cwd, env: config.envs[vendor as keyof typeof config.envs], encoding: 'utf8' }
			);

			expect(snapshot.status).toBe(0);

			let roleInserted = false;
			let userInserted = false;

			try {
				await db('directus_roles').insert({ id: roleId, key: roleKey, name: 'Impact Probe', app_access: false });
				roleInserted = true;

				await db('directus_permissions').insert({
					role: roleId,
					collection,
					action: 'read',
					permissions: null,
					validation: null,
					presets: null,
					fields: '*',
				});

				await db('directus_presets').insert({ role: roleId, bookmark });

				await db('directus_users').insert({ id: userId, email: `${roleKey}@example.invalid`, role: roleId });
				userInserted = true;

				const expiresAt = Date.now() + 3600 * 1000;
				const expires = vendor === 'sqlite3' ? expiresAt : new Date(expiresAt);
				await db('directus_sessions').insert({ token, user: userId, expires });

				const httpDry = await applyConfig(vendor, baseline, { dryRun: true });
				expect(httpDry.statusCode).toBe(200);

				const cli = spawnSync(
					'node',
					['--no-node-snapshot', paths.cli, 'config', 'apply', fixtureRoot, '--dry-run', '--format', 'json'],
					{ cwd: paths.cwd, env: config.envs[vendor as keyof typeof config.envs], encoding: 'utf8' }
				);

				expect(cli.status).toBe(1);

				const cliDocument = JSON.parse(cli.stdout);
				expect(cliDocument).toEqual(httpDry.body.data);

				const roleDeletion = httpDry.body.data.changes.find(
					(change: any) => change.kind === 'roles' && change.operation === 'delete' && change.identity.key === roleKey
				);

				expect(roleDeletion).toBeDefined();

				expect(roleDeletion.impact).toEqual([
					{ kind: 'permissions', identity: { role: roleKey, collection, action: 'read' } },
					{ kind: 'presets', count: 1, bookmarks: [bookmark] },
					{ kind: 'users', suspended: [userId] },
					{ kind: 'sessions', active: 1 },
				]);
			} finally {
				await db('directus_sessions').where({ token }).del();
				if (userInserted) await db('directus_users').where({ id: userId }).del();
				await db('directus_presets').where({ role: roleId }).del();
				await db('directus_permissions').where({ role: roleId }).del();
				if (roleInserted) await db('directus_roles').where({ id: roleId }).del();
			}
		});
	});
});

describe('Config-as-Code audit and events', () => {
	type Id = string | number;
	type ProbeIds = { roleIds: Set<Id>; permIds: Set<Id>; userIds: Set<Id>; presetIds: Set<Id> };

	const databases = new Map<string, Knex>();

	beforeAll(() => {
		for (const vendor of vendors) databases.set(vendor, knex(config.knexConfig[vendor]!));
	});

	afterAll(async () => {
		for (const [, db] of databases) await db.destroy();
	});

	function newIds(): ProbeIds {
		return { roleIds: new Set(), permIds: new Set(), userIds: new Set(), presetIds: new Set() };
	}

	function probeRole(key: string): Record<string, unknown> {
		return {
			key,
			name: 'Audit Probe',
			admin_access: false,
			app_access: false,
			icon: 'supervised_user_circle',
			enforce_tfa: false,
			description: null,
			ip_access: null,
		};
	}

	function probePermissionSet(
		roleKey: string,
		collection: string
	): { role: string; permissions: Array<Record<string, unknown>> } {
		return {
			role: roleKey,
			permissions: [{ collection, action: 'read', permissions: null, validation: null, presets: null, fields: ['*'] }],
		};
	}

	async function markerCount(db: Knex, key: string): Promise<number> {
		return (await db('tests_extensions_log').where({ key })).length;
	}

	async function expectAudited(
		db: Knex,
		collection: string,
		item: Id,
		action: 'create' | 'update' | 'delete',
		expectedUser: Id | null,
		expectRevision: boolean
	): Promise<Record<string, unknown>> {
		const activities = await db('directus_activity').where({ collection, item: String(item), action });

		expect(activities.length).toBe(1);
		const activity = activities[0]!;
		expect(activity.user).toBe(expectedUser);

		const revisions = await db('directus_revisions').where({ activity: activity.id });

		if (expectRevision) {
			expect(revisions.length).toBe(1);
			expect(revisions[0]!.collection).toBe(collection);
			expect(String(revisions[0]!.item)).toBe(String(item));
		} else {
			expect(revisions.length).toBe(0);
		}

		return activity;
	}

	async function idsFor(db: Knex, table: string, where: Record<string, unknown>): Promise<Id[]> {
		const rows = await db(table).where(where).select('id');
		return rows.map((row) => row.id as Id);
	}

	async function purge(db: Knex, roleKey: string, ids: ProbeIds, collections: string[]): Promise<void> {
		const role = await db('directus_roles').where({ key: roleKey }).first();

		if (role) {
			ids.roleIds.add(role.id);
			for (const id of await idsFor(db, 'directus_permissions', { role: role.id })) ids.permIds.add(id);
			for (const id of await idsFor(db, 'directus_users', { role: role.id })) ids.userIds.add(id);
			for (const id of await idsFor(db, 'directus_presets', { role: role.id })) ids.presetIds.add(id);
		}

		const roleIds = [...ids.roleIds];
		const permIds = [...ids.permIds];
		const userIds = [...ids.userIds];
		const presetIds = [...ids.presetIds];

		for (const [collection, items] of [
			['directus_roles', roleIds],
			['directus_permissions', permIds],
			['directus_users', userIds],
			['directus_presets', presetIds],
		] as const) {
			for (const item of items) {
				await db('directus_revisions')
					.where({ collection, item: String(item) })
					.del();

				await db('directus_activity')
					.where({ collection, item: String(item) })
					.del();
			}
		}

		await db('tests_extensions_log')
			.where({ key: `config-apply-probe/roles.create/${roleKey}` })
			.del();

		for (const collection of collections) {
			await db('tests_extensions_log')
				.where({ key: `config-apply-probe/permissions.create/${collection}` })
				.del();
		}

		for (const id of [...roleIds, ...permIds, ...userIds]) {
			await db('tests_extensions_log').where('key', 'like', `config-apply-probe/%/${id}`).del();
		}

		for (const id of presetIds) await db('directus_presets').where({ id }).del();
		for (const id of userIds) await db('directus_users').where({ id }).del();
		for (const id of permIds) await db('directus_permissions').where({ id }).del();
		for (const id of roleIds) await db('directus_permissions').where({ role: id }).del();
		for (const id of roleIds) await db('directus_roles').where({ id }).del();
	}

	describe('an HTTP apply attributes create and update audit to the administrator and dispatches their events', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const roleKey = `audit_probe_${suffix}_${rand}`;
			const probeCollection = `audit_probe_${rand}`;
			const ids = newIds();

			try {
				const admin = await db('directus_users').where({ email: 'admin@default.com' }).first();
				expect(admin).toBeDefined();

				const created = await getBaseline(vendor);
				created.roles.push(probeRole(roleKey));
				created.permissions.push(probePermissionSet(roleKey, probeCollection));

				const createResp = await applyConfig(vendor, created);
				expect(createResp.statusCode).toBe(200);

				expect(createResp.body.data).toEqual({
					roles: { created: [roleKey], updated: [], deleted: [] },
					permissions: { created: 1, updated: 0, deleted: 0 },
				});

				const role = await db('directus_roles').where({ key: roleKey }).first();
				expect(role).toBeDefined();
				ids.roleIds.add(role.id);

				const perm = await db('directus_permissions').where({ role: role.id, collection: probeCollection }).first();
				expect(perm).toBeDefined();
				ids.permIds.add(perm.id);

				await expectAudited(db, 'directus_roles', role.id, 'create', admin.id, true);
				await expectAudited(db, 'directus_permissions', perm.id, 'create', admin.id, true);

				expect(await markerCount(db, `config-apply-probe/roles.create/${roleKey}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/permissions.create/${probeCollection}`)).toBe(1);

				const updated = await adminSnapshot(vendor);
				const roleDoc = updated.roles.find((r) => r['key'] === roleKey);
				expect(roleDoc).toBeDefined();
				roleDoc!['name'] = 'Audit Probe Renamed';
				const permSet = updated.permissions.find((p) => p.role === roleKey);
				expect(permSet).toBeDefined();
				permSet!.permissions[0]!['fields'] = ['id'];

				const updateResp = await applyConfig(vendor, updated);
				expect(updateResp.statusCode).toBe(200);

				expect(updateResp.body.data).toEqual({
					roles: { created: [], updated: [roleKey], deleted: [] },
					permissions: { created: 0, updated: 1, deleted: 0 },
				});

				await expectAudited(db, 'directus_roles', role.id, 'update', admin.id, true);
				await expectAudited(db, 'directus_permissions', perm.id, 'update', admin.id, true);

				const after = await adminSnapshot(vendor);
				const afterRole = after.roles.find((r) => r['key'] === roleKey);
				expect(afterRole).toBeDefined();
				expect(afterRole!['name']).toBe('Audit Probe Renamed');
				const afterPermSet = after.permissions.find((p) => p.role === roleKey);
				expect(afterPermSet).toBeDefined();
				expect(afterPermSet!.permissions[0]!['fields']).toEqual(['id']);

				expect(await markerCount(db, `config-apply-probe/roles.update/${role.id}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/permissions.update/${perm.id}`)).toBe(1);
			} finally {
				await purge(db, roleKey, ids, [probeCollection]);
			}
		});
	});

	describe('a local CLI apply attributes activity to the system actor and awaits its events before exit', () => {
		let fixtureRoot: string;

		beforeEach(async () => {
			fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-audit-'));
		});

		afterEach(async () => {
			await fs.rm(fixtureRoot, { recursive: true, force: true });
		});

		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const roleKey = `audit_probe_cli_${suffix}_${rand}`;
			const ids = newIds();

			const snapshot = spawnSync(
				'node',
				['--no-node-snapshot', paths.cli, 'config', 'snapshot', fixtureRoot, '--yes'],
				{ cwd: paths.cwd, env: config.envs[vendor as keyof typeof config.envs], encoding: 'utf8' }
			);

			expect(snapshot.status).toBe(0);

			await fs.writeFile(path.join(fixtureRoot, 'roles', `${roleKey}.yaml`), dumpYaml(probeRole(roleKey)));

			try {
				const apply = spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'apply', fixtureRoot, '--yes'], {
					cwd: paths.cwd,
					env: { ...config.envs[vendor as keyof typeof config.envs], LOG_LEVEL: 'info', LOG_STYLE: 'raw' },
					encoding: 'utf8',
				});

				expect(apply.status).toBe(0);
				expect(`${apply.stdout ?? ''}${apply.stderr ?? ''}`).toContain('1 role(s) created');

				const role = await db('directus_roles').where({ key: roleKey }).first();
				expect(role).toBeDefined();
				ids.roleIds.add(role.id);

				const activity = await expectAudited(db, 'directus_roles', role.id, 'create', null, true);
				expect(activity['origin']).toBe('config-cli');

				expect(await markerCount(db, `config-apply-probe/roles.create/${roleKey}`)).toBe(1);
			} finally {
				await purge(db, roleKey, ids, []);
			}
		});
	});

	describe('a rollback commits no role row, audit rows, or events', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const roleKey = `audit_probe_rollback_${suffix}_${rand}`;
			const ids = newIds();

			const desired = await getBaseline(vendor);
			desired.roles.push(probeRole(roleKey));
			desired.permissions.push(probePermissionSet(roleKey, 'audit_probe_rollback'));

			const activityBefore = new Set(await idsFor(db, 'directus_activity', { collection: 'directus_roles' }));
			const revisionsBefore = new Set(await idsFor(db, 'directus_revisions', { collection: 'directus_roles' }));

			try {
				const response = await applyConfig(vendor, desired);
				expect(response.statusCode).toBe(500);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('CONFIG_APPLY_FAILED');

				const addedActivity = (await idsFor(db, 'directus_activity', { collection: 'directus_roles' })).filter(
					(id) => !activityBefore.has(id)
				);

				const addedRevisions = (await idsFor(db, 'directus_revisions', { collection: 'directus_roles' })).filter(
					(id) => !revisionsBefore.has(id)
				);

				expect(addedActivity).toEqual([]);
				expect(addedRevisions).toEqual([]);
				expect(await db('directus_roles').where({ key: roleKey }).first()).toBeUndefined();
				expect(await markerCount(db, `config-apply-probe/roles.create/${roleKey}`)).toBe(0);
			} finally {
				// Recompute during teardown so assertion failures cannot leak audit rows.
				const leakedRevisions = (await idsFor(db, 'directus_revisions', { collection: 'directus_roles' })).filter(
					(id) => !revisionsBefore.has(id)
				);

				for (const id of leakedRevisions) await db('directus_revisions').where({ id }).del();

				const leakedActivity = (await idsFor(db, 'directus_activity', { collection: 'directus_roles' })).filter(
					(id) => !activityBefore.has(id)
				);

				for (const id of leakedActivity) await db('directus_activity').where({ id }).del();

				await purge(db, roleKey, ids, ['audit_probe_rollback']);
			}
		});
	});

	describe('a role deletion records delete activity without a revision and cascades to users and presets', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const roleKey = `audit_probe_del_${suffix}_${rand}`;
			const probeCollection = `audit_probe_del_${rand}`;
			const userId = randomUUID();
			const ids = newIds();

			try {
				const admin = await db('directus_users').where({ email: 'admin@default.com' }).first();
				expect(admin).toBeDefined();

				const created = await getBaseline(vendor);
				created.roles.push(probeRole(roleKey));
				created.permissions.push(probePermissionSet(roleKey, probeCollection));

				const createResp = await applyConfig(vendor, created);
				expect(createResp.statusCode).toBe(200);

				expect(createResp.body.data).toEqual({
					roles: { created: [roleKey], updated: [], deleted: [] },
					permissions: { created: 1, updated: 0, deleted: 0 },
				});

				const role = await db('directus_roles').where({ key: roleKey }).first();
				expect(role).toBeDefined();
				ids.roleIds.add(role.id);

				const perm = await db('directus_permissions').where({ role: role.id, collection: probeCollection }).first();
				expect(perm).toBeDefined();
				ids.permIds.add(perm.id);

				await db('directus_users').insert({
					id: userId,
					email: `${roleKey}@example.invalid`,
					role: role.id,
					status: 'active',
				});

				ids.userIds.add(userId);

				await db('directus_presets').insert({ role: role.id, bookmark: 'Audit Probe Bookmark' });
				const preset = await db('directus_presets').where({ role: role.id }).first();
				expect(preset).toBeDefined();
				ids.presetIds.add(preset.id);

				const snapshot = await adminSnapshot(vendor);
				snapshot.roles = snapshot.roles.filter((r) => r['key'] !== roleKey);
				snapshot.permissions = snapshot.permissions.filter((p) => p.role !== roleKey);

				const deleteResp = await applyConfig(vendor, snapshot, { destructive: true });
				expect(deleteResp.statusCode).toBe(200);

				expect(deleteResp.body.data).toEqual({
					roles: { created: [], updated: [], deleted: [roleKey] },
					permissions: { created: 0, updated: 0, deleted: 0 },
				});

				expect(await db('directus_roles').where({ id: role.id }).first()).toBeUndefined();
				expect(await db('directus_permissions').where({ id: perm.id }).first()).toBeUndefined();
				expect(await db('directus_presets').where({ id: preset.id }).first()).toBeUndefined();

				await expectAudited(db, 'directus_roles', role.id, 'delete', admin.id, false);
				await expectAudited(db, 'directus_permissions', perm.id, 'delete', admin.id, false);
				await expectAudited(db, 'directus_users', userId, 'update', admin.id, true);

				expect(
					await db('directus_activity')
						.where({ collection: 'directus_presets', item: String(preset.id) })
						.first()
				).toBeUndefined();

				expect(
					await db('directus_revisions')
						.where({ collection: 'directus_presets', item: String(preset.id) })
						.first()
				).toBeUndefined();

				const suspendedUser = await db('directus_users').where({ id: userId }).first();
				expect(suspendedUser).toBeDefined();
				expect(suspendedUser.status).toBe('suspended');
				expect(suspendedUser.role).toBeNull();

				expect(await markerCount(db, `config-apply-probe/roles.create/${roleKey}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/permissions.create/${probeCollection}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/roles.delete/${role.id}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/permissions.delete/${perm.id}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/users.update/${userId}`)).toBe(1);
			} finally {
				await purge(db, roleKey, ids, [probeCollection]);
			}
		});
	});

	describe('an HTTP apply runs deletions in reverse dependency order, deleting permissions before roles', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const survivorKey = `audit_probe_survivor_${suffix}_${rand}`;
			const removedKey = `audit_probe_removed_${suffix}_${rand}`;
			const survivorCollection = `audit_probe_surv_${rand}`;
			const removedCollection = `audit_probe_rem_${rand}`;
			const ids = newIds();

			try {
				const created = await getBaseline(vendor);
				created.roles.push(probeRole(survivorKey));
				created.roles.push(probeRole(removedKey));
				created.permissions.push(probePermissionSet(survivorKey, survivorCollection));
				created.permissions.push(probePermissionSet(removedKey, removedCollection));

				const createResp = await applyConfig(vendor, created);
				expect(createResp.statusCode).toBe(200);
				expect([...createResp.body.data.roles.created].sort()).toEqual([removedKey, survivorKey].sort());
				expect(createResp.body.data.roles.updated).toEqual([]);
				expect(createResp.body.data.roles.deleted).toEqual([]);
				expect(createResp.body.data.permissions).toEqual({ created: 2, updated: 0, deleted: 0 });

				const survivorRole = await db('directus_roles').where({ key: survivorKey }).first();
				const removedRole = await db('directus_roles').where({ key: removedKey }).first();
				expect(survivorRole).toBeDefined();
				expect(removedRole).toBeDefined();
				ids.roleIds.add(survivorRole.id);
				ids.roleIds.add(removedRole.id);

				const survivorPerm = await db('directus_permissions')
					.where({ role: survivorRole.id, collection: survivorCollection })
					.first();

				const removedPerm = await db('directus_permissions')
					.where({ role: removedRole.id, collection: removedCollection })
					.first();

				expect(survivorPerm).toBeDefined();
				expect(removedPerm).toBeDefined();
				ids.permIds.add(survivorPerm.id);
				ids.permIds.add(removedPerm.id);

				// The survivor's permission is standalone; the removed role's permission is cascade-subsumed.
				const desired = await adminSnapshot(vendor);
				desired.roles = desired.roles.filter((r) => r['key'] !== removedKey);
				desired.permissions = desired.permissions.filter((p) => p.role !== removedKey && p.role !== survivorKey);

				const deleteResp = await applyConfig(vendor, desired, { destructive: true });
				expect(deleteResp.statusCode).toBe(200);

				expect(deleteResp.body.data).toEqual({
					roles: { created: [], updated: [], deleted: [removedKey] },
					permissions: { created: 0, updated: 0, deleted: 1 },
				});

				const after = await adminSnapshot(vendor);
				expect(after).toEqual(desired);

				const permFilter = await db('tests_extensions_log')
					.where({ key: `config-apply-probe/permissions.delete.filter/${survivorPerm.id}` })
					.first();

				const roleFilter = await db('tests_extensions_log')
					.where({ key: `config-apply-probe/roles.delete.filter/${removedRole.id}` })
					.first();

				expect(permFilter).toBeDefined();
				expect(roleFilter).toBeDefined();
				expect(Number(permFilter.id)).toBeLessThan(Number(roleFilter.id));

				const permAction = await db('tests_extensions_log')
					.where({ key: `config-apply-probe/permissions.delete/${survivorPerm.id}` })
					.first();

				const roleAction = await db('tests_extensions_log')
					.where({ key: `config-apply-probe/roles.delete/${removedRole.id}` })
					.first();

				expect(permAction).toBeDefined();
				expect(roleAction).toBeDefined();
				expect(Number(permAction.id)).toBeLessThan(Number(roleAction.id));

				expect(await markerCount(db, `config-apply-probe/permissions.delete/${survivorPerm.id}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/roles.delete/${removedRole.id}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/permissions.delete.filter/${survivorPerm.id}`)).toBe(1);
				expect(await markerCount(db, `config-apply-probe/roles.delete.filter/${removedRole.id}`)).toBe(1);

				const permActivity = await db('directus_activity')
					.where({ collection: 'directus_permissions', item: String(survivorPerm.id), action: 'delete' })
					.first();

				const roleActivity = await db('directus_activity')
					.where({ collection: 'directus_roles', item: String(removedRole.id), action: 'delete' })
					.first();

				expect(permActivity).toBeDefined();
				expect(roleActivity).toBeDefined();
				expect(Number(permActivity.id)).toBeLessThan(Number(roleActivity.id));
			} finally {
				await purge(db, survivorKey, ids, [survivorCollection]);
				await purge(db, removedKey, ids, [removedCollection]);
			}
		});
	});

	describe('a failed role deletion rolls back the whole apply, restoring records and leaving no audit or event rows', () => {
		it.each(vendors)('%s', async (vendor) => {
			const db = databases.get(vendor)!;
			const suffix = vendor.replace(/[^a-z0-9_]/gi, '_');
			const rand = randomUUID().replace(/-/g, '').slice(0, 8);
			const survivorKey = `audit_probe_survivor_${suffix}_${rand}`;
			const rollbackKey = `audit_probe_delrollback_${suffix}_${rand}`;
			const survivorCollection = `audit_probe_surv_${rand}`;
			const ids = newIds();

			try {
				const created = await getBaseline(vendor);
				created.roles.push(probeRole(survivorKey));
				created.roles.push(probeRole(rollbackKey));
				created.permissions.push(probePermissionSet(survivorKey, survivorCollection));

				const createResp = await applyConfig(vendor, created);
				expect(createResp.statusCode).toBe(200);

				const survivorRole = await db('directus_roles').where({ key: survivorKey }).first();
				const rollbackRole = await db('directus_roles').where({ key: rollbackKey }).first();
				expect(survivorRole).toBeDefined();
				expect(rollbackRole).toBeDefined();
				ids.roleIds.add(survivorRole.id);
				ids.roleIds.add(rollbackRole.id);

				const survivorPerm = await db('directus_permissions')
					.where({ role: survivorRole.id, collection: survivorCollection })
					.first();

				expect(survivorPerm).toBeDefined();
				ids.permIds.add(survivorPerm.id);

				const desired = await adminSnapshot(vendor);
				desired.roles = desired.roles.filter((r) => r['key'] !== rollbackKey);
				desired.permissions = desired.permissions.filter((p) => p.role !== survivorKey);

				const deleteResp = await applyConfig(vendor, desired, { destructive: true });
				expect(deleteResp.statusCode).toBe(500);
				expect(deleteResp.body.errors?.[0]?.extensions?.code).toBe('CONFIG_APPLY_FAILED');

				expect(await db('directus_permissions').where({ id: survivorPerm.id }).first()).toBeDefined();
				expect(await db('directus_roles').where({ id: rollbackRole.id }).first()).toBeDefined();
				expect(await db('directus_roles').where({ id: survivorRole.id }).first()).toBeDefined();

				expect(
					await db('directus_activity')
						.where({ collection: 'directus_permissions', item: String(survivorPerm.id), action: 'delete' })
						.first()
				).toBeUndefined();

				expect(
					await db('directus_activity')
						.where({ collection: 'directus_roles', item: String(rollbackRole.id), action: 'delete' })
						.first()
				).toBeUndefined();

				expect(await markerCount(db, `config-apply-probe/permissions.delete/${survivorPerm.id}`)).toBe(0);
				expect(await markerCount(db, `config-apply-probe/roles.delete/${rollbackRole.id}`)).toBe(0);
				expect(await markerCount(db, `config-apply-probe/permissions.delete.filter/${survivorPerm.id}`)).toBe(0);
				expect(await markerCount(db, `config-apply-probe/roles.delete.filter/${rollbackRole.id}`)).toBe(0);
			} finally {
				await purge(db, survivorKey, ids, [survivorCollection]);
				await purge(db, rollbackKey, ids, []);
			}
		});
	});
});

function unreachableDbEnv(vendor: string): NodeJS.ProcessEnv {
	const base = config.envs[vendor as keyof typeof config.envs];

	if (vendor === 'sqlite3') {
		return { ...base, DB_FILENAME: path.join(os.tmpdir(), `cairncms-unreachable-${randomUUID()}`, 'db.sqlite') };
	}

	return { ...base, DB_HOST: '127.0.0.1', DB_PORT: '1' };
}

describe('cairncms config apply exit codes and machine output', () => {
	let fixtureRoot: string;

	beforeEach(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-apply-codes-'));
	});

	afterEach(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	function runApply(vendor: string, args: string[], env?: NodeJS.ProcessEnv) {
		return spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'apply', ...args], {
			cwd: paths.cwd,
			env: env ?? config.envs[vendor as keyof typeof config.envs],
			encoding: 'utf8',
		});
	}

	async function snapshotBaseline(vendor: string): Promise<void> {
		const result = spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'snapshot', fixtureRoot, '--yes'], {
			cwd: paths.cwd,
			env: config.envs[vendor as keyof typeof config.envs],
			encoding: 'utf8',
		});

		expect(result.status).toBe(0);
	}

	describe('exits 0 on a mutating apply with no changes', () => {
		it.each(vendors)('%s', async (vendor) => {
			await snapshotBaseline(vendor);
			expect(runApply(vendor, [fixtureRoot, '--yes']).status).toBe(0);
		});
	});

	describe('exits 1 on a dry run with drift', () => {
		it.each(vendors)('%s', async (vendor) => {
			await snapshotBaseline(vendor);
			const key = `exit_drift_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;

			await fs.writeFile(
				path.join(fixtureRoot, 'roles', `${key}.yaml`),
				dumpYaml({ key, name: 'Exit Drift', admin_access: false, app_access: true })
			);

			expect(runApply(vendor, [fixtureRoot, '--dry-run']).status).toBe(1);
		});
	});

	describe('exits 0 on an empty dry run and emits the full JSON document', () => {
		it.each(vendors)('%s', async (vendor) => {
			await snapshotBaseline(vendor);
			const result = runApply(vendor, [fixtureRoot, '--dry-run', '--format', 'json']);

			expect(result.status).toBe(0);

			const httpDry = await applyConfig(vendor, await getBaseline(vendor), { dryRun: true });
			expect(httpDry.statusCode).toBe(200);
			expect(JSON.parse(result.stdout)).toEqual(httpDry.body.data);
		});
	});

	describe('exits 2 and refuses a deletion without --destructive', () => {
		it.each(vendors)('%s', async (vendor) => {
			const baseline = await getBaseline(vendor);
			const orphanKey = `cli_refuse_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;

			await snapshotBaseline(vendor);

			const withOrphan = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
			withOrphan.roles.push({ key: orphanKey, name: 'CLI Refuse Orphan', admin_access: false, app_access: true });

			try {
				expect((await applyConfig(vendor, withOrphan)).statusCode).toBe(200);

				const afterSetup = await adminSnapshot(vendor);

				const env = { ...config.envs[vendor as keyof typeof config.envs], LOG_LEVEL: 'info', LOG_STYLE: 'raw' };
				const result = runApply(vendor, [fixtureRoot, '--yes'], env);
				const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

				expect(result.status).toBe(2);
				expect(output).toContain('Apply refused');
				expect(output).toContain(orphanKey);

				const after = await adminSnapshot(vendor);

				expect(after).toEqual(afterSetup);
			} finally {
				await resetToBaseline(vendor);
			}
		});
	});

	describe('keeps standard output pure in machine mode', () => {
		it.each(vendors)('%s', async (vendor) => {
			await snapshotBaseline(vendor);
			await fs.writeFile(path.join(fixtureRoot, 'roles', 'Unowned.yaml'), dumpYaml({ note: 'ignored' }));

			const env = { ...config.envs[vendor as keyof typeof config.envs], LOG_LEVEL: 'warn', LOG_STYLE: 'raw' };
			const result = runApply(vendor, [fixtureRoot, '--dry-run', '--format', 'json'], env);

			expect(result.status).toBe(0);
			expect(() => JSON.parse(result.stdout)).not.toThrow();
			expect(result.stderr).toContain('Ignoring');
			expect(result.stdout).not.toContain('Ignoring');
		});
	});

	describe('exits 2 on an unknown --format', () => {
		it.each(vendors)('%s', async (vendor) => {
			await snapshotBaseline(vendor);
			expect(runApply(vendor, [fixtureRoot, '--dry-run', '--format', 'xml']).status).toBe(2);
		});
	});

	describe('exits 2 on --format json without --dry-run before reading the config path', () => {
		it.each(vendors)('%s', (vendor) => {
			const result = runApply(vendor, [path.join(fixtureRoot, 'does-not-exist'), '--format', 'json']);

			expect(result.status).toBe(2);
			expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('only available with --dry-run');
		});
	});

	describe('exits 2 on a missing path argument', () => {
		it.each(vendors)('%s', (vendor) => {
			expect(runApply(vendor, []).status).toBe(2);
		});
	});

	describe('exits 0 on --help', () => {
		it.each(vendors)('%s', (vendor) => {
			expect(runApply(vendor, ['--help']).status).toBe(0);
		});
	});

	describe('exits 3 when the database is unreachable', () => {
		it.each(vendors)('%s', async (vendor) => {
			await snapshotBaseline(vendor);
			const result = runApply(vendor, [fixtureRoot, '--yes'], unreachableDbEnv(vendor));
			expect(result.status).toBe(3);
			expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(`Can't connect to the database.`);
		});
	});
});

describe('cairncms config snapshot exit codes', () => {
	let fixtureRoot: string;

	beforeEach(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-snap-codes-'));
	});

	afterEach(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	function runSnapshot(vendor: string, args: string[], env?: NodeJS.ProcessEnv) {
		return spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'snapshot', ...args], {
			cwd: paths.cwd,
			env: env ?? config.envs[vendor as keyof typeof config.envs],
			encoding: 'utf8',
		});
	}

	describe('exits 0 on a successful snapshot', () => {
		it.each(vendors)('%s', (vendor) => {
			expect(runSnapshot(vendor, [fixtureRoot, '--yes']).status).toBe(0);
		});
	});

	describe('exits 0 on --help', () => {
		it.each(vendors)('%s', (vendor) => {
			expect(runSnapshot(vendor, ['--help']).status).toBe(0);
		});
	});

	describe('exits 2 on a missing path argument', () => {
		it.each(vendors)('%s', (vendor) => {
			expect(runSnapshot(vendor, []).status).toBe(2);
		});
	});

	describe('exits 2 on an invalid existing tree', () => {
		it.each(vendors)('%s', async (vendor) => {
			await fs.writeFile(
				path.join(fixtureRoot, 'cairncms-config.yaml'),
				dumpYaml({ version: 99, resources: ['roles'] })
			);

			expect(runSnapshot(vendor, [fixtureRoot, '--yes']).status).toBe(2);
		});
	});

	describe('exits 3 when the database is unreachable', () => {
		it.each(vendors)('%s', (vendor) => {
			const result = runSnapshot(vendor, [fixtureRoot, '--yes'], unreachableDbEnv(vendor));
			expect(result.status).toBe(3);
			expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(`Can't connect to the database.`);
		});
	});
});
