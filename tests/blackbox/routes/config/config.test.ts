import request from 'supertest';
import { spawnSync } from 'child_process';
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

/** Reads validation messages without depending on the transport envelope. */
function errorMessages(response: { body: { errors?: unknown } }): string[] {
	const errors = response.body.errors;
	if (!Array.isArray(errors)) return [];
	return errors.map((error: unknown) =>
		typeof error === 'string' ? error : String((error as { message?: unknown }).message ?? '')
	);
}

/**
 * Places a filter on a public permission. The filter uses canonical grammar against a real field, so a
 * rejection can only come from the guard under test rather than from later filter validation.
 */
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
				const baseline = await getBaseline(vendor);
				const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
				const probeKey = `dryrun_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;

				desired.roles.push({
					key: probeKey,
					name: 'Dry Run Probe',
					admin_access: false,
					app_access: true,
				});

				const dry = await applyConfig(vendor, desired, { dryRun: true });

				expect(dry.statusCode).toBe(200);
				expect(dry.body.data.roles.created).toContain(probeKey);

				const snap = await request(getUrl(vendor))
					.get('/config/snapshot')
					.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

				expect(snap.body.data.roles.find((r: any) => r.key === probeKey)).toBeUndefined();
			});
		});

		describe('non-destructive apply preserves orphan roles', () => {
			it.each(vendors)('%s', async (vendor) => {
				const baseline = await getBaseline(vendor);
				const orphanKey = `orphan_keep_${vendor.replace(/[^a-z0-9_]/gi, '_')}`;

				const desiredCreate = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;

				desiredCreate.roles.push({
					key: orphanKey,
					name: 'Orphan Keep',
					admin_access: false,
					app_access: true,
				});

				try {
					const create = await applyConfig(vendor, desiredCreate);
					expect(create.statusCode).toBe(200);
					expect(create.body.data.roles.created).toContain(orphanKey);

					const nonDestructive = await applyConfig(vendor, baseline);
					expect(nonDestructive.statusCode).toBe(200);
					expect(nonDestructive.body.data.roles.deleted).toEqual([]);

					const snap = await request(getUrl(vendor))
						.get('/config/snapshot')
						.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);

					expect(snap.body.data.roles.find((r: any) => r.key === orphanKey)).toBeDefined();
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
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
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
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
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
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
				expect(response.body.errors[0].message).toContain('roles[0]');
				expect(response.body.errors[0].message).toContain('key');
			});
		});

		describe('returns flat error array for validation failures', () => {
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
				expect(Array.isArray(response.body.errors)).toBe(true);
				expect(typeof response.body.errors[0]).toBe('string');
				expect(response.body.errors.some((e: string) => e.includes('Unsupported config version: 99'))).toBe(true);
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

	function expectApplyRefused(vendor: string, diagnostic: string): void {
		const result = spawnSync('node', ['--no-node-snapshot', paths.cli, 'config', 'apply', fixtureRoot, '--yes'], {
			cwd: paths.cwd,
			env: config.envs[vendor as keyof typeof config.envs],
			encoding: 'utf8',
		});

		expect(result.error).toBeUndefined();
		expect(typeof result.status).toBe('number');
		expect(result.status).not.toBe(0);
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

			expectApplyRefused(vendor, 'declares version 99');
			expect(await snapshotData(vendor)).toEqual(before);
		});
	});

	describe('a managed directory whose link does not resolve terminates nonzero and writes nothing', () => {
		it.each(vendors)('%s', async (vendor) => {
			const before = await snapshotData(vendor);
			await writeManifest();
			await fs.symlink(path.join(fixtureRoot, 'never-created'), path.join(fixtureRoot, 'roles'));

			expectApplyRefused(vendor, 'is a link that does not resolve');
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
				expectApplyRefused(vendor, 'outside the CAIRNCMS_CONFIG_ namespace');

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
				expectApplyRefused(vendor, 'bogus_field');

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

			// A JSON array is valid JSON on every vendor, so the column accepts it and the read path is what
			// rejects it. Syntactically broken text would be refused by Postgres before reaching the engine.
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
