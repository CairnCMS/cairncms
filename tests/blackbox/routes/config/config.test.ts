import request from 'supertest';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';

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
	desired: ConfigSnapshot,
	options: { destructive?: boolean; dryRun?: boolean } = {}
) {
	const req = request(getUrl(vendor))
		.post('/config/apply')
		.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`)
		.set('Content-Type', 'application/json');

	if (options.destructive) req.query({ destructive: 'true' });
	if (options.dryRun) req.query({ dry_run: 'true' });

	return req.send(desired);
}

async function resetToBaseline(vendor: string): Promise<void> {
	const baseline = await getBaseline(vendor);
	await applyConfig(vendor, baseline, { destructive: true });
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
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
				expect(response.body.errors[0].message).toContain('Invalid YAML');
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
