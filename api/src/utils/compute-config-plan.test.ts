import { describe, expect, it } from 'vitest';
import { computeConfigPlan, validateConfigPlan } from './compute-config-plan.js';
import type { DirectusConfig } from '../types/config.js';

const emptyManifest = { version: 1 as const, resources: ['roles' as const, 'permissions' as const] };

function makeConfig(overrides?: Partial<DirectusConfig>): DirectusConfig {
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
		expect(plan.roles.update[0]!.diff).toEqual({ name: 'Content Editor' });
	});

	it('does not flag unchanged roles as updates', () => {
		const role = makeRole('editor', { name: 'Editor', icon: 'edit' });
		const current = makeConfig({ roles: [role] });
		const desired = makeConfig({ roles: [{ ...role }] });
		const plan = computeConfigPlan(current, desired);

		expect(plan.roles.update).toEqual([]);
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
			permissions: [
				{ role: 'editor', permissions: [{ ...makePerm('articles', 'read'), fields: ['title'] }] },
			],
		});

		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [
				{ role: 'editor', permissions: [{ ...makePerm('articles', 'read'), fields: ['title', 'body'] }] },
			],
		});

		const plan = computeConfigPlan(current, desired);
		expect(plan.permissions.update).toHaveLength(1);
	});

	it('does not delete permissions for roles not in desired config', () => {
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
		expect(plan.permissions.delete).toEqual([]);
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

		expect(result.errors).toEqual([]);
	});

	it('errors when permission references unknown role', () => {
		const desired = makeConfig({
			permissions: [{ role: 'ghost', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('ghost');
	});

	it('allows permission referencing role that exists in DB but not config', () => {
		const desired = makeConfig({
			permissions: [{ role: 'legacy', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map([['legacy', { admin_access: false }]]) });

		expect(result.errors).toEqual([]);
	});

	it('allows public permissions without a role entry', () => {
		const desired = makeConfig({
			permissions: [{ role: 'public', permissions: [makePerm('articles', 'read')] }],
		});

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result.errors).toEqual([]);
	});

	it('errors when deleting the last admin role', () => {
		const current = makeConfig({ roles: [makeRole('administrator', { admin_access: true })] });
		const desired = makeConfig();

		const plan = computeConfigPlan(current, desired);
		const result = validateConfigPlan(plan, desired, {
			currentRoles: new Map([['administrator', { admin_access: true }]]),
		});

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('last admin role');
	});

	it('allows deleting an admin role when another admin remains', () => {
		const current = makeConfig({
			roles: [
				makeRole('administrator', { admin_access: true }),
				makeRole('super_admin', { admin_access: true }),
			],
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

		expect(result.errors).toEqual([]);
	});

	it('errors when deleting admin role and only non-admin roles remain', () => {
		const current = makeConfig({
			roles: [
				makeRole('administrator', { admin_access: true }),
				makeRole('editor', { admin_access: false }),
			],
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

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('last admin role');
	});

	it('errors when config version is unsupported', () => {
		const desired = makeConfig();
		(desired.manifest as any).version = 2;

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('Unsupported config version');
	});

	it('errors when a role uses reserved key "public"', () => {
		const desired = makeConfig({
			roles: [makeRole('public')],
		});

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.some((e) => e.includes('reserved for public permissions'))).toBe(true);
	});

	it('errors on duplicate permission tuples', () => {
		const desired = makeConfig({
			roles: [makeRole('editor')],
			permissions: [
				{
					role: 'editor',
					permissions: [makePerm('articles', 'read'), makePerm('articles', 'read')],
				},
			],
		});

		const plan = computeConfigPlan(makeConfig(), desired);
		const result = validateConfigPlan(plan, desired, { currentRoles: new Map() });

		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
	});
});
