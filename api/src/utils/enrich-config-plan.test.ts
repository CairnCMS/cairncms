import type { PermissionsAction, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import type { CairnConfig, ConfigKind, ConfigPermission, ConfigPermissionSet, ConfigPlan } from '../types/config.js';
import { permissionsDescriptor } from './config/handlers/permissions.js';
import { rolesDescriptor } from './config/handlers/roles.js';
import { CONFIG_REGISTRY } from './config/registry.js';
import { enrichConfigPlan } from './enrich-config-plan.js';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function planDeletingRoles(...keys: string[]): ConfigPlan {
	return {
		roles: { create: [], update: [], delete: keys },
		permissions: { create: [], update: [], delete: [] },
		protections: [],
	};
}

function makeConfig(resources: ConfigKind[], permissions: ConfigPermissionSet[] = []): CairnConfig {
	return {
		manifest: { version: 1, resources },
		roles: [],
		permissions,
	};
}

function perm(collection: string, action: PermissionsAction = 'read'): ConfigPermission {
	return { collection, action, permissions: null, validation: null, presets: null, fields: null };
}

function schemaWith(...collections: string[]): SchemaOverview {
	const map: Record<string, unknown> = {};
	for (const collection of collections) map[collection] = {};
	return { collections: map } as unknown as SchemaOverview;
}

describe('enrichConfigPlan', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
		vi.restoreAllMocks();
	});

	it('issues no impact queries when the plan deletes no roles', async () => {
		const enrichment = await enrichConfigPlan(planDeletingRoles(), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		});

		expect(tracker.history.select).toHaveLength(0);
		expect(enrichment.roleDeletionImpact.size).toBe(0);
		expect(enrichment.warnings).toEqual([]);
	});

	it("reads a deleted role's permission tuples from the database even when the manifest is roles-only", async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);

		tracker.on.select('directus_permissions').response([
			{ role: 'r1', collection: 'articles', action: 'read' },
			{ role: 'r1', collection: 'articles', action: 'create' },
		]);

		tracker.on.select('directus_presets').response([]);
		tracker.on.select('directus_users').response([]);

		const enrichment = await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		});

		expect(enrichment.roleDeletionImpact.get('editor')).toEqual([
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'create' } },
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			{ kind: 'presets', count: 0, bookmarks: [] },
			{ kind: 'users', suspended: [] },
			{ kind: 'sessions', active: 0 },
		]);
	});

	it('attributes interleaved dependent rows to the correct role', async () => {
		tracker.on.select('directus_roles').response([
			{ id: 'r1', key: 'editor' },
			{ id: 'r2', key: 'author' },
		]);

		tracker.on.select('directus_permissions').response([
			{ role: 'r2', collection: 'pages', action: 'read' },
			{ role: 'r1', collection: 'articles', action: 'read' },
		]);

		tracker.on.select('directus_presets').response([
			{ role: 'r2', bookmark: 'Author View' },
			{ role: 'r1', bookmark: null },
		]);

		tracker.on.select('directus_users').response([
			{ id: 'u2', role: 'r2' },
			{ id: 'u1', role: 'r1' },
		]);

		tracker.on.select('directus_sessions').response([
			{ user: 'u1', expires: FUTURE },
			{ user: 'u2', expires: FUTURE },
			{ user: 'u2', expires: FUTURE },
		]);

		const enrichment = await enrichConfigPlan(planDeletingRoles('editor', 'author'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		});

		expect(enrichment.roleDeletionImpact.get('editor')).toEqual([
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			{ kind: 'presets', count: 1, bookmarks: [] },
			{ kind: 'users', suspended: ['u1'] },
			{ kind: 'sessions', active: 1 },
		]);

		expect(enrichment.roleDeletionImpact.get('author')).toEqual([
			{ kind: 'permissions', identity: { role: 'author', collection: 'pages', action: 'read' } },
			{ kind: 'presets', count: 1, bookmarks: ['Author View'] },
			{ kind: 'users', suspended: ['u2'] },
			{ kind: 'sessions', active: 2 },
		]);
	});

	it('aborts with CONFIG_READ_FAILED when a deleted role no longer resolves, producing no partial impact', async () => {
		tracker.on.select('directus_roles').response([]);
		tracker.on.select('directus_permissions').response([]);

		await expect(
			enrichConfigPlan(planDeletingRoles('ghost'), makeConfig(['roles']), { schema: schemaWith(), database: db })
		).rejects.toBeInstanceOf(ConfigReadFailedException);

		expect(tracker.history.select.some((query) => /directus_permissions/.test(query.sql))).toBe(false);
	});

	it('reports every affected preset as a count and lists non-null bookmark values', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);

		tracker.on.select('directus_presets').response([
			{ role: 'r1', bookmark: 'Sales Q1' },
			{ role: 'r1', bookmark: 'Team Board' },
			{ role: 'r1', bookmark: null },
			{ role: 'r1', bookmark: '' },
		]);

		tracker.on.select('directus_users').response([]);

		const enrichment = await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		});

		expect(enrichment.roleDeletionImpact.get('editor')).toContainEqual({
			kind: 'presets',
			count: 4,
			bookmarks: ['', 'Sales Q1', 'Team Board'],
		});
	});

	it('lists affected user ids and counts only unexpired sessions, filtered in the query', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('directus_presets').response([]);

		tracker.on.select('directus_users').response([
			{ id: 'u2', role: 'r1' },
			{ id: 'u1', role: 'r1' },
		]);

		tracker.on.select('directus_sessions').response([
			{ user: 'u1', expires: FUTURE },
			{ user: 'u2', expires: PAST },
			{ user: 'u1', expires: FUTURE },
		]);

		const enrichment = await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		});

		const entries = enrichment.roleDeletionImpact.get('editor')!;

		expect(entries).toContainEqual({ kind: 'users', suspended: ['u1', 'u2'] });
		expect(entries).toContainEqual({ kind: 'sessions', active: 2 });

		const sessionQuery = tracker.history.select.find((query) => /directus_sessions/.test(query.sql));
		expect(sessionQuery?.sql).toMatch(/"expires"\s*>=\s*\?/);
		expect(sessionQuery?.bindings.at(-1)).toBeInstanceOf(Date);
	});

	it('reports the three aggregate entries with zero counts for a role with no dependents', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('directus_presets').response([]);
		tracker.on.select('directus_users').response([]);

		const enrichment = await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		});

		expect(enrichment.roleDeletionImpact.get('editor')).toEqual([
			{ kind: 'presets', count: 0, bookmarks: [] },
			{ kind: 'users', suspended: [] },
			{ kind: 'sessions', active: 0 },
		]);

		expect(tracker.history.select.some((query) => /directus_sessions/.test(query.sql))).toBe(false);
	});

	it('aborts with the access-remediation message and no driver detail when an impact read fails', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').simulateError('permissions table unavailable');

		const error = (await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		}).catch((thrown) => thrown)) as ConfigReadFailedException;

		expect(error).toBeInstanceOf(ConfigReadFailedException);
		expect(error.message).toContain('Restore database access');
		expect(error.message).toContain('permissions cascaded by a role deletion');
		expect(error.message).not.toContain('permissions table unavailable');
	});

	it('aborts with the consistency-remediation message naming the subject on an unsupported action', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([{ role: 'r1', collection: 'articles', action: 'frobnicate' }]);
		tracker.on.select('directus_presets').response([]);
		tracker.on.select('directus_users').response([]);

		const error = (await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
			schema: schemaWith(),
			database: db,
		}).catch((thrown) => thrown)) as ConfigReadFailedException;

		expect(error).toBeInstanceOf(ConfigReadFailedException);
		expect(error.message).toContain('Restore database consistency');
		expect(error.message).toContain('editor');
		expect(error.message).toContain('unsupported action');
	});

	it('aborts when a cascaded preset has a non-string bookmark', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('directus_presets').response([{ role: 'r1', bookmark: 42 }]);
		tracker.on.select('directus_users').response([]);

		await expect(
			enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), { schema: schemaWith(), database: db })
		).rejects.toBeInstanceOf(ConfigReadFailedException);
	});

	it('aborts when an affected user row has no usable id', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('directus_presets').response([]);
		tracker.on.select('directus_users').response([{ id: null, role: 'r1' }]);

		await expect(
			enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), { schema: schemaWith(), database: db })
		).rejects.toBeInstanceOf(ConfigReadFailedException);
	});

	it('aborts when a session has an unreadable expiry', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('directus_presets').response([]);
		tracker.on.select('directus_users').response([{ id: 'u1', role: 'r1' }]);
		tracker.on.select('directus_sessions').response([{ user: 'u1', expires: 'not-a-date' }]);

		await expect(
			enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), { schema: schemaWith(), database: db })
		).rejects.toBeInstanceOf(ConfigReadFailedException);
	});

	it('warns for a desired permission whose collection is missing from the schema, even with no plan entry', async () => {
		const desired = makeConfig(
			['roles', 'permissions'],
			[{ role: 'editor', permissions: [perm('ghost_collection', 'read')] }]
		);

		const enrichment = await enrichConfigPlan(planDeletingRoles(), desired, {
			schema: schemaWith('articles'),
			database: db,
		});

		expect(enrichment.warnings).toEqual([
			{
				code: 'COLLECTION_MISSING',
				kind: 'permissions',
				identity: { role: 'editor', collection: 'ghost_collection', action: 'read' },
				message: expect.stringContaining('ghost_collection'),
			},
		]);

		expect(tracker.history.select).toHaveLength(0);
	});

	it('warns for a collection named like an inherited object property', async () => {
		const desired = makeConfig(
			['roles', 'permissions'],
			[{ role: 'editor', permissions: [perm('constructor', 'read')] }]
		);

		const enrichment = await enrichConfigPlan(planDeletingRoles(), desired, {
			schema: schemaWith('articles'),
			database: db,
		});

		expect(enrichment.warnings).toHaveLength(1);
		expect(enrichment.warnings[0]!.identity.collection).toBe('constructor');
	});

	it('does not warn when the permission collection exists in the schema', async () => {
		const desired = makeConfig(['roles', 'permissions'], [{ role: 'editor', permissions: [perm('articles', 'read')] }]);

		const enrichment = await enrichConfigPlan(planDeletingRoles(), desired, {
			schema: schemaWith('articles'),
			database: db,
		});

		expect(enrichment.warnings).toEqual([]);
	});

	it('does not scan or warn on desired permissions when permissions are unmanaged, even if malformed', async () => {
		const desired: CairnConfig = {
			manifest: { version: 1, resources: ['roles'] },
			roles: [],
			permissions: [
				{
					role: 'x',
					permissions: [
						{
							collection: 123 as unknown as string,
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: null,
						},
					],
				},
			],
		};

		const enrichment = await enrichConfigPlan(planDeletingRoles(), desired, {
			schema: schemaWith('articles'),
			database: db,
		});

		expect(enrichment.warnings).toEqual([]);
	});

	it('merges the handler fragments into exactly roleDeletionImpact and warnings', async () => {
		const enrichment = await enrichConfigPlan(planDeletingRoles(), makeConfig(['roles', 'permissions']), {
			schema: schemaWith(),
			database: db,
		});

		expect(Object.keys(enrichment).sort()).toEqual(['roleDeletionImpact', 'warnings']);
	});

	it('rejects a duplicate fragment key from the handlers', async () => {
		vi.spyOn(permissionsDescriptor.handler, 'emptyEnrichment').mockReturnValue({
			roleDeletionImpact: new Map(),
		} as never);

		await expect(
			enrichConfigPlan(planDeletingRoles(), makeConfig(['roles']), { schema: schemaWith(), database: db })
		).rejects.toThrow(/duplicate fragment key "roleDeletionImpact"/);
	});

	it('computes deletion impact for an active role-delete slice even when roles are unmanaged', async () => {
		tracker.on.select('directus_roles').response([{ id: 'r1', key: 'editor' }]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('directus_presets').response([]);
		tracker.on.select('directus_users').response([]);

		const enrichment = await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['permissions']), {
			schema: schemaWith(),
			database: db,
		});

		expect(enrichment.roleDeletionImpact.has('editor')).toBe(true);
	});

	it('ignores a null permissions payload when permissions are unmanaged', async () => {
		const desired: CairnConfig = {
			manifest: { version: 1, resources: ['roles'] },
			roles: [],
			permissions: [null] as unknown as CairnConfig['permissions'],
		};

		const plan: ConfigPlan = {
			roles: { create: [], update: [], delete: [] },
			permissions: { create: [{ roleKey: 'x', permission: perm('articles') }], update: [], delete: [] },
			protections: [],
		};

		const enrichment = await enrichConfigPlan(plan, desired, { schema: schemaWith('articles'), database: db });

		expect(enrichment.warnings).toEqual([]);
	});

	it('routes role enrichment through the registry descriptor', async () => {
		const real = CONFIG_REGISTRY.roles;

		CONFIG_REGISTRY.roles = {
			...real,
			handler: { ...real.handler, enrich: async () => ({ roleDeletionImpact: new Map([['registry_sentinel', []]]) }) },
		};

		try {
			const enrichment = await enrichConfigPlan(planDeletingRoles('editor'), makeConfig(['roles']), {
				schema: schemaWith(),
				database: db,
			});

			expect(enrichment.roleDeletionImpact).toEqual(new Map([['registry_sentinel', []]]));
			expect(tracker.history.select).toHaveLength(0);
		} finally {
			CONFIG_REGISTRY.roles = real;
		}
	});
});

describe('handler emptyEnrichment', () => {
	it('returns fresh empty values on each call', () => {
		const a = rolesDescriptor.handler.emptyEnrichment();
		const b = rolesDescriptor.handler.emptyEnrichment();
		expect(a).toEqual({ roleDeletionImpact: new Map() });
		expect(a.roleDeletionImpact).not.toBe(b.roleDeletionImpact);

		const p1 = permissionsDescriptor.handler.emptyEnrichment();
		const p2 = permissionsDescriptor.handler.emptyEnrichment();
		expect(p1).toEqual({ warnings: [] });
		expect(p1.warnings).not.toBe(p2.warnings);
	});
});
