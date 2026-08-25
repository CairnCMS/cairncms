import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeConfigPlan, validateConfigPlan } from './compute-config-plan.js';
import { CONFIG_REGISTRY } from './config/registry.js';
import { rolesDescriptor } from './config/handlers/roles.js';
import type { CairnConfig, ConfigKind } from '../types/config.js';

const emptyManifest = { version: 1 as const, resources: ['roles' as const, 'permissions' as const] };

function manifestFor(...resources: ConfigKind[]) {
	return { version: 1 as const, resources };
}

function makeConfig(overrides?: Partial<CairnConfig>): CairnConfig {
	return {
		manifest: emptyManifest,
		roles: [],
		permissions: [],
		...overrides,
	};
}

function makeRole(key: string, overrides?: Record<string, any>) {
	return { key, name: key, admin_access: false, app_access: true, ...overrides };
}

function makePerm(collection: string, action: string) {
	return { collection, action: action as any, permissions: null, validation: null, presets: null, fields: null };
}

describe('computeConfigPlan', () => {
	it('returns empty plan when current and desired match', () => {
		const config = makeConfig({ roles: [makeRole('editor')] });
		const plan = computeConfigPlan(config, config);

		expect(plan.roles.create).toEqual([]);
		expect(plan.roles.update).toEqual([]);
		expect(plan.roles.delete).toEqual([]);
		expect(plan.permissions.create).toEqual([]);
		expect(plan.permissions.update).toEqual([]);
		expect(plan.permissions.delete).toEqual([]);
	});

	it('detects new roles to create', () => {
		const current = makeConfig();
		const desired = makeConfig({ roles: [makeRole('editor')] });
		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.create).toHaveLength(1);
		expect(plan.roles.create[0]!.key).toBe('editor');
	});

	it('detects roles to delete', () => {
		const current = makeConfig({ roles: [makeRole('editor')] });
		const desired = makeConfig();
		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.delete).toEqual(['editor']);
	});

	it('detects role updates', () => {
		const current = makeConfig({ roles: [makeRole('editor', { name: 'Editor' })] });
		const desired = makeConfig({ roles: [makeRole('editor', { name: 'Content Editor' })] });
		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.update).toHaveLength(1);
		expect(plan.roles.update[0]!.key).toBe('editor');
		expect(plan.roles.update[0]!.changes).toEqual({ name: { before: 'Editor', after: 'Content Editor' } });
	});

	it('does not flag unchanged roles as updates', () => {
		const role = makeRole('editor', { name: 'Editor', icon: 'edit' });
		const current = makeConfig({ roles: [role] });
		const desired = makeConfig({ roles: [{ ...role }] });
		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.update).toEqual([]);
	});

	describe('omit-preserve role diff semantics', () => {
		it('does not emit a role update when desired omits optional fields that exist in current', () => {
			const current = makeConfig({
				roles: [makeRole('editor', { icon: 'edit', enforce_tfa: true })],
			});

			const desired = makeConfig({ roles: [makeRole('editor')] });
			const plan = computeConfigPlan(current, desired);

			expect(plan.roles.update).toEqual([]);
		});

		it('does not clear description when desired omits it', () => {
			const current = makeConfig({
				roles: [makeRole('editor', { description: 'old description' })],
			});

			const desired = makeConfig({ roles: [makeRole('editor')] });
			const plan = computeConfigPlan(current, desired);

			expect(plan.roles.update).toEqual([]);
		});

		it('does not clear ip_access when desired omits it', () => {
			const current = makeConfig({
				roles: [makeRole('editor', { ip_access: ['10.0.0.0/8'] })],
			});

			const desired = makeConfig({ roles: [makeRole('editor')] });
			const plan = computeConfigPlan(current, desired);

			expect(plan.roles.update).toEqual([]);
		});

		it('clears nullable description when desired sets it explicitly to null', () => {
			const current = makeConfig({
				roles: [makeRole('editor', { description: 'old description' })],
			});

			const desired = makeConfig({
				roles: [makeRole('editor', { description: null })],
			});

			const plan = computeConfigPlan(current, desired);

			expect(plan.roles.update).toHaveLength(1);
			expect(plan.roles.update[0]!.changes).toEqual({ description: { before: 'old description', after: null } });
		});

		it('emits an ip_access change when desired sets a new value', () => {
			const current = makeConfig({
				roles: [makeRole('editor', { ip_access: null })],
			});

			const desired = makeConfig({
				roles: [makeRole('editor', { ip_access: ['10.0.0.0/8'] })],
			});

			const plan = computeConfigPlan(current, desired);

			expect(plan.roles.update).toHaveLength(1);
			expect(plan.roles.update[0]!.changes).toEqual({ ip_access: { before: null, after: ['10.0.0.0/8'] } });
		});
	});

	it('detects new permissions to create', () => {
		const current = makeConfig({ roles: [makeRole('editor')] });

		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(current, desired);
		expect(plan.permissions.create).toHaveLength(1);
		expect(plan.permissions.create[0]!.permission.collection).toBe('articles');
	});

	it('detects permissions to delete', () => {
		const current = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const desired = makeConfig({ roles: [makeRole('editor')] });
		const plan = computeConfigPlan(current, desired);

		expect(plan.permissions.delete).toHaveLength(1);
		expect(plan.permissions.delete[0]!.collection).toBe('articles');
	});

	it('detects permission updates', () => {
		const current = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [{ ...makePerm('articles', 'read'), fields: ['title'] }] }],
		});

		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [{ ...makePerm('articles', 'read'), fields: ['title', 'body'] }] }],
		});

		const plan = computeConfigPlan(current, desired);
		expect(plan.permissions.update).toHaveLength(1);
		expect(plan.permissions.update[0]!.changes).toEqual({ fields: { before: ['title'], after: ['body', 'title'] } });
	});

	it('does not emit a role update when ip_access is only reordered', () => {
		const current = makeConfig({ roles: [makeRole('editor', { ip_access: ['10.0.0.1', '10.0.0.2'] })] });
		const desired = makeConfig({ roles: [makeRole('editor', { ip_access: ['10.0.0.2', '10.0.0.1'] })] });

		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.update).toEqual([]);
	});

	it('does not emit a permission update when fields are only reordered', () => {
		const current = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [{ ...makePerm('articles', 'read'), fields: ['title', 'body'] }] }],
		});

		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [{ ...makePerm('articles', 'read'), fields: ['body', 'title'] }] }],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.permissions.update).toEqual([]);
	});

	it('does not queue permissions for a role the plan deletes, because the cascade removes them', () => {
		const current = makeConfig({
			roles: [makeRole('editor'), makeRole('viewer')],
			permissions: [
				{ role: 'editor', permissions: [makePerm('articles', 'read')] },
				{ role: 'viewer', permissions: [makePerm('pages', 'read')] },
			],
		});

		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.delete).toEqual(['viewer']);
		expect(plan.permissions.delete).toEqual([]);
	});

	it('keeps surviving permission deletes in current-state order when a cascaded delete is removed between them', () => {
		const current = makeConfig({
			roles: [makeRole('editor'), makeRole('viewer'), makeRole('author')],
			permissions: [
				{ role: 'editor', permissions: [makePerm('articles', 'read'), makePerm('pages', 'read')] },
				{ role: 'viewer', permissions: [makePerm('items', 'read')] },
				{ role: 'author', permissions: [makePerm('comments', 'read'), makePerm('notes', 'read')] },
			],
		});

		const desired = makeConfig({
			roles: [makeRole('editor'), makeRole('author')],
			permissions: [
				{ role: 'editor', permissions: [makePerm('articles', 'read')] },
				{ role: 'author', permissions: [makePerm('comments', 'read')] },
			],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.delete).toEqual(['viewer']);

		expect(plan.permissions.delete).toEqual([
			{ roleKey: 'editor', collection: 'pages', action: 'read' },
			{ roleKey: 'author', collection: 'notes', action: 'read' },
		]);
	});

	it('routes role planning through the registry descriptor', () => {
		const real = CONFIG_REGISTRY.roles;

		CONFIG_REGISTRY.roles = {
			...real,
			handler: {
				...real.handler,
				postPlan: (plan) => ({ ...plan, create: [...plan.create, makeRole('registry_sentinel')] }),
			},
		};

		try {
			const config = makeConfig({ roles: [makeRole('editor')] });
			const plan = computeConfigPlan(config, config);
			expect(plan.roles).toEqual({ create: [makeRole('registry_sentinel')], update: [], delete: [] });
		} finally {
			CONFIG_REGISTRY.roles = real;
		}
	});

	it('handles public permissions', () => {
		const current = makeConfig();

		const desired = makeConfig({
			permissions: [{ role: 'public', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(current, desired);
		expect(plan.permissions.create).toHaveLength(1);
		expect(plan.permissions.create[0]!.roleKey).toBe('public');
	});

	it('deletes public permissions when in current but not desired', () => {
		const current = makeConfig({
			permissions: [{ role: 'public', permissions: [makePerm('articles', 'read')] }],
		});

		const desired = makeConfig({
			permissions: [{ role: 'public', permissions: [] }],
		});

		const plan = computeConfigPlan(current, desired);
		expect(plan.permissions.delete).toHaveLength(1);
		expect(plan.permissions.delete[0]!.roleKey).toBe('public');
	});
});

describe('validateConfigPlan', () => {
	it('returns no errors for a valid plan', () => {
		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result).toEqual([]);
	});

	it('checks only plan-dependent invariants, reporting no document-validity error', () => {
		const desired = makeConfig({
			roles: [makeRole('public')],
			permissions: [{ role: 'ghost', permissions: [makePerm('articles', 'read'), makePerm('articles', 'read')] }],
		});

		(desired.manifest as any).version = 2;

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result).toEqual([]);
	});

	it('errors when deleting the last admin role', () => {
		const current = makeConfig({ roles: [makeRole('administrator', { admin_access: true })] });
		const desired = makeConfig();

		const plan = computeConfigPlan(current, desired);

		const result = validateConfigPlan(plan, desired, {
			currentRoles: new Map([['administrator', { admin_access: true }]]),
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.message).toContain('last admin role');
		expect(result[0]!.code).toBe('CONFIG_PROTECTED_RECORD');
	});

	it('allows deleting an admin role when another admin remains', () => {
		const current = makeConfig({
			roles: [makeRole('administrator', { admin_access: true }), makeRole('super_admin', { admin_access: true })],
		});

		const desired = makeConfig({
			roles: [makeRole('super_admin', { admin_access: true })],
		});

		const plan = computeConfigPlan(current, desired);

		const result = validateConfigPlan(plan, desired, {
			currentRoles: new Map([
				['administrator', { admin_access: true }],
				['super_admin', { admin_access: true }],
			]),
		});

		expect(result).toEqual([]);
	});

	it('errors when deleting admin role and only non-admin roles remain', () => {
		const current = makeConfig({
			roles: [makeRole('administrator', { admin_access: true }), makeRole('editor', { admin_access: false })],
		});

		const desired = makeConfig({
			roles: [makeRole('editor', { admin_access: false })],
		});

		const plan = computeConfigPlan(current, desired);

		const result = validateConfigPlan(plan, desired, {
			currentRoles: new Map([
				['administrator', { admin_access: true }],
				['editor', { admin_access: false }],
			]),
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.message).toContain('last admin role');
		expect(result[0]!.code).toBe('CONFIG_PROTECTED_RECORD');
	});
});

describe('managed scope', () => {
	afterEach(() => vi.restoreAllMocks());

	it('leaves every permission alone in all directions when the manifest declares only roles', () => {
		const current = makeConfig({
			roles: [makeRole('editor'), makeRole('viewer')],
			permissions: [
				{ role: 'editor', permissions: [makePerm('articles', 'read'), makePerm('pages', 'read')] },
				{ role: 'viewer', permissions: [makePerm('articles', 'read')] },
			],
		});

		const desired = makeConfig({
			manifest: manifestFor('roles'),
			roles: [makeRole('editor')],
			permissions: [
				{
					role: 'editor',
					permissions: [{ ...makePerm('articles', 'read'), fields: ['title'] }, makePerm('items', 'create')],
				},
			],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.delete).toEqual(['viewer']);
		expect(plan.permissions).toEqual({ create: [], update: [], delete: [] });
	});

	it('leaves every role alone when the manifest declares only permissions', () => {
		const current = makeConfig({ roles: [makeRole('editor'), makeRole('viewer')] });

		const desired = makeConfig({
			manifest: manifestFor('permissions'),
			roles: [makeRole('editor', { name: 'Renamed' }), makeRole('author')],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.roles).toEqual({ create: [], update: [], delete: [] });
	});

	it('deletes a stale permission when roles are unmanaged, because no role deletion can cascade', () => {
		const current = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const desired = makeConfig({
			manifest: manifestFor('permissions'),
			roles: [],
			permissions: [{ role: 'editor', permissions: [] }],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.permissions.delete).toEqual([{ roleKey: 'editor', collection: 'articles', action: 'read' }]);
	});

	it('queues nothing when the manifest declares no kinds', () => {
		const current = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const desired = makeConfig({
			manifest: manifestFor(),
			roles: [makeRole('viewer')],
			permissions: [{ role: 'viewer', permissions: [makePerm('pages', 'update')] }],
		});

		expect(computeConfigPlan(current, desired)).toEqual({
			roles: { create: [], update: [], delete: [] },
			permissions: { create: [], update: [], delete: [] },
		});
	});

	it('publishes each finalized dependency plan before planning dependents', () => {
		vi.spyOn(rolesDescriptor.handler, 'postPlan').mockImplementation((plan) => ({
			...plan,
			delete: [...plan.delete, 'phantom'],
		}));

		const current = makeConfig({
			roles: [makeRole('editor'), makeRole('phantom')],
			permissions: [{ role: 'phantom', permissions: [makePerm('articles', 'read')] }],
		});

		const desired = makeConfig({
			roles: [makeRole('editor'), makeRole('phantom')],
			permissions: [{ role: 'phantom', permissions: [] }],
		});

		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.delete).toEqual(['phantom']);
		expect(plan.permissions.delete).toEqual([]);
	});

	it('ignores a null permissions entry while planning managed roles', () => {
		const current = makeConfig({ roles: [makeRole('editor')] });

		const desired = makeConfig({
			manifest: manifestFor('roles'),
			roles: [makeRole('viewer')],
			permissions: [null] as unknown as CairnConfig['permissions'],
		});

		expect(computeConfigPlan(current, desired)).toEqual({
			roles: { create: [makeRole('viewer')], update: [], delete: ['editor'] },
			permissions: { create: [], update: [], delete: [] },
		});
	});

	it('ignores a null roles entry while planning managed permissions', () => {
		const current = makeConfig({
			roles: [makeRole('editor')],
			permissions: [{ role: 'editor', permissions: [makePerm('articles', 'read')] }],
		});

		const desired = makeConfig({
			manifest: manifestFor('permissions'),
			roles: [null] as unknown as CairnConfig['roles'],
			permissions: [{ role: 'editor', permissions: [] }],
		});

		expect(computeConfigPlan(current, desired)).toEqual({
			roles: { create: [], update: [], delete: [] },
			permissions: {
				create: [],
				update: [],
				delete: [{ roleKey: 'editor', collection: 'articles', action: 'read' }],
			},
		});
	});

	it('does not report a last-administrator error when roles are unmanaged', () => {
		const current = makeConfig({ roles: [makeRole('admin', { admin_access: true })] });
		const desired = makeConfig({ manifest: manifestFor('permissions'), roles: [] });

		const plan = computeConfigPlan(current, desired);
		const currentRoles = new Map([['admin', { admin_access: true }]]);

		expect(plan.roles.delete).toEqual([]);
		expect(validateConfigPlan(plan, desired, { currentRoles })).toEqual([]);
	});
});
