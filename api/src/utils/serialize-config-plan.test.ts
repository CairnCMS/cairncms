import type { PermissionsAction } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import type {
	ConfigPermission,
	ConfigPlan,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigPlanWarning,
	ConfigRole,
	RoleDeletionImpactEntry,
} from '../types/config.js';
import { canonicalizeRole } from './canonicalize-config-record.js';
import { serializeConfigPlan } from './serialize-config-plan.js';

function emptyPlan(): ConfigPlan {
	return {
		roles: { create: [], update: [], delete: [] },
		permissions: { create: [], update: [], delete: [] },
	};
}

function emptyEnrichment(): ConfigPlanEnrichment {
	return { roleDeletionImpact: new Map(), warnings: [] };
}

function role(key: string): ConfigRole {
	return { key, name: key, admin_access: false, app_access: true };
}

function perm(collection: string, action: PermissionsAction = 'read'): ConfigPermission {
	return { collection, action, permissions: null, validation: null, presets: null, fields: null };
}

function warning(role: string, collection: string, action: PermissionsAction = 'read'): ConfigPlanWarning {
	return {
		code: 'COLLECTION_MISSING',
		kind: 'permissions',
		identity: { role, collection, action },
		message: 'missing',
	};
}

function zeroImpact(): RoleDeletionImpactEntry[] {
	return [
		{ kind: 'presets', count: 0, bookmarks: [] },
		{ kind: 'users', suspended: [] },
		{ kind: 'sessions', active: 0 },
	];
}

function labelOf(change: ConfigPlanChange): string {
	if (change.kind === 'roles') return `roles/${change.operation}/${change.identity.key}`;
	return `permissions/${change.operation}/${change.identity.role}:${change.identity.collection}:${change.identity.action}`;
}

describe('serializeConfigPlan', () => {
	it('serializes an empty plan completely', () => {
		const result = serializeConfigPlan(emptyPlan(), { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result).toEqual({
			planVersion: 1,
			manifestVersion: 1,
			changes: [],
			summary: { create: 0, update: 0, delete: 0 },
			warnings: [],
		});
	});

	it('carries warnings on an otherwise empty plan', () => {
		const enrichment: ConfigPlanEnrichment = { roleDeletionImpact: new Map(), warnings: [warning('editor', 'ghost')] };

		const result = serializeConfigPlan(emptyPlan(), { enrichment, manifestVersion: 1 });

		expect(result.changes).toEqual([]);
		expect(result.summary).toEqual({ create: 0, update: 0, delete: 0 });
		expect(result.warnings).toEqual([warning('editor', 'ghost')]);
	});

	it('serializes a role create with canonicalized values', () => {
		const created = role('author');
		const plan = emptyPlan();
		plan.roles.create.push(created);

		const result = serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.changes).toEqual([
			{ kind: 'roles', operation: 'create', identity: { key: 'author' }, values: canonicalizeRole(created) },
		]);

		expect(canonicalizeRole(created).icon).toBe('supervised_user_circle');
	});

	it('serializes a role update carrying its field changes', () => {
		const plan = emptyPlan();
		plan.roles.update.push({ key: 'editor', diff: { name: 'X' }, changes: { name: { before: 'Editor', after: 'X' } } });

		const result = serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.changes).toEqual([
			{
				kind: 'roles',
				operation: 'update',
				identity: { key: 'editor' },
				fields: { name: { before: 'Editor', after: 'X' } },
			},
		]);
	});

	it('serializes a permission create with canonicalized values', () => {
		const plan = emptyPlan();
		plan.permissions.create.push({ roleKey: 'editor', permission: perm('articles', 'read') });

		const result = serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.changes).toEqual([
			{
				kind: 'permissions',
				operation: 'create',
				identity: { role: 'editor', collection: 'articles', action: 'read' },
				values: { permissions: null, validation: null, presets: null, fields: null },
			},
		]);
	});

	it('serializes a permission update carrying its field changes', () => {
		const plan = emptyPlan();

		plan.permissions.update.push({
			roleKey: 'editor',
			permission: perm('articles', 'read'),
			changes: { fields: { before: null, after: ['title'] } },
		});

		const result = serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.changes).toEqual([
			{
				kind: 'permissions',
				operation: 'update',
				identity: { role: 'editor', collection: 'articles', action: 'read' },
				fields: { fields: { before: null, after: ['title'] } },
			},
		]);
	});

	it('serializes a permission deletion with an empty impact', () => {
		const plan = emptyPlan();
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });

		const result = serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.changes).toEqual([
			{
				kind: 'permissions',
				operation: 'delete',
				identity: { role: 'editor', collection: 'articles', action: 'read' },
				impact: [],
			},
		]);
	});

	it('embeds a role deletion impact into the complete serialized envelope', () => {
		const impact: RoleDeletionImpactEntry[] = [
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			{ kind: 'presets', count: 1, bookmarks: ['Board'] },
			{ kind: 'users', suspended: ['u1'] },
			{ kind: 'sessions', active: 2 },
		];

		const enrichment: ConfigPlanEnrichment = { roleDeletionImpact: new Map([['editor', impact]]), warnings: [] };
		const plan = emptyPlan();
		plan.roles.delete.push('editor');

		const result = serializeConfigPlan(plan, { enrichment, manifestVersion: 1 });

		expect(result).toEqual({
			planVersion: 1,
			manifestVersion: 1,
			changes: [{ kind: 'roles', operation: 'delete', identity: { key: 'editor' }, impact }],
			summary: { create: 0, update: 0, delete: 1 },
			warnings: [],
		});
	});

	it('throws CONFIG_READ_FAILED naming the role when a deleted role has no computed impact', () => {
		const plan = emptyPlan();
		plan.roles.delete.push('editor');

		let error: unknown;

		try {
			serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });
		} catch (thrown) {
			error = thrown;
		}

		expect(error).toBeInstanceOf(ConfigReadFailedException);
		expect((error as ConfigReadFailedException).code).toBe('CONFIG_READ_FAILED');
		expect((error as Error).message).toContain('editor');
		expect((error as Error).message).toContain('Retry the operation and report the failure if it persists');
		expect((error as Error).message).not.toContain('Restore database');
	});

	it('throws when a role deletion impact is missing an aggregate entry', () => {
		const impact: RoleDeletionImpactEntry[] = [
			{ kind: 'presets', count: 0, bookmarks: [] },
			{ kind: 'users', suspended: [] },
		];

		const plan = emptyPlan();
		plan.roles.delete.push('editor');

		expect(() =>
			serializeConfigPlan(plan, {
				enrichment: { roleDeletionImpact: new Map([['editor', impact]]), warnings: [] },
				manifestVersion: 1,
			})
		).toThrow(ConfigReadFailedException);
	});

	it('throws when a role deletion impact has a duplicate aggregate entry', () => {
		const impact: RoleDeletionImpactEntry[] = [
			{ kind: 'presets', count: 0, bookmarks: [] },
			{ kind: 'presets', count: 1, bookmarks: ['x'] },
			{ kind: 'users', suspended: [] },
			{ kind: 'sessions', active: 0 },
		];

		const plan = emptyPlan();
		plan.roles.delete.push('editor');

		expect(() =>
			serializeConfigPlan(plan, {
				enrichment: { roleDeletionImpact: new Map([['editor', impact]]), warnings: [] },
				manifestVersion: 1,
			})
		).toThrow(ConfigReadFailedException);
	});

	it('normalizes a shuffled impact into a stable serialized order', () => {
		const ordered: RoleDeletionImpactEntry[] = [
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'create' } },
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			{ kind: 'presets', count: 2, bookmarks: ['A', 'B'] },
			{ kind: 'users', suspended: ['u1', 'u2'] },
			{ kind: 'sessions', active: 3 },
		];

		const shuffled: RoleDeletionImpactEntry[] = [
			{ kind: 'sessions', active: 3 },
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			{ kind: 'users', suspended: ['u2', 'u1'] },
			{ kind: 'presets', count: 2, bookmarks: ['B', 'A'] },
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'create' } },
		];

		const build = (impact: RoleDeletionImpactEntry[]) => {
			const plan = emptyPlan();
			plan.roles.delete.push('editor');

			return serializeConfigPlan(plan, {
				enrichment: { roleDeletionImpact: new Map([['editor', impact]]), warnings: [] },
				manifestVersion: 1,
			});
		};

		expect(build(shuffled).changes).toEqual([
			{ kind: 'roles', operation: 'delete', identity: { key: 'editor' }, impact: ordered },
		]);

		expect(build(shuffled)).toEqual(build(ordered));
	});

	it('orders changes by kind, operation, then identity regardless of input order', () => {
		const plan = emptyPlan();
		plan.permissions.delete.push({ roleKey: 'zeta', collection: 'z', action: 'read' });
		plan.roles.delete.push('zebra');
		plan.roles.create.push(role('beta'), role('alpha'));
		plan.roles.update.push({ key: 'gamma', diff: { name: 'G' }, changes: { name: { before: 'x', after: 'G' } } });

		plan.permissions.create.push(
			{ roleKey: 'alpha', permission: perm('articles', 'read') },
			{ roleKey: 'alpha', permission: perm('articles', 'create') }
		);

		plan.permissions.update.push({
			roleKey: 'beta',
			permission: perm('pages', 'read'),
			changes: { fields: { before: null, after: ['x'] } },
		});

		const enrichment: ConfigPlanEnrichment = { roleDeletionImpact: new Map([['zebra', zeroImpact()]]), warnings: [] };
		const result = serializeConfigPlan(plan, { enrichment, manifestVersion: 1 });

		expect(result.changes.map(labelOf)).toEqual([
			'roles/create/alpha',
			'roles/create/beta',
			'roles/update/gamma',
			'roles/delete/zebra',
			'permissions/create/alpha:articles:create',
			'permissions/create/alpha:articles:read',
			'permissions/update/beta:pages:read',
			'permissions/delete/zeta:z:read',
		]);
	});

	it('serializes identically regardless of input order', () => {
		const first = emptyPlan();
		first.roles.create.push(role('beta'), role('alpha'));

		first.permissions.create.push(
			{ roleKey: 'alpha', permission: perm('articles', 'read') },
			{ roleKey: 'alpha', permission: perm('articles', 'create') }
		);

		const second = emptyPlan();
		second.roles.create.push(role('alpha'), role('beta'));

		second.permissions.create.push(
			{ roleKey: 'alpha', permission: perm('articles', 'create') },
			{ roleKey: 'alpha', permission: perm('articles', 'read') }
		);

		const a = serializeConfigPlan(first, { enrichment: emptyEnrichment(), manifestVersion: 1 });
		const b = serializeConfigPlan(second, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(a).toEqual(b);
	});

	it('sorts warnings by identity regardless of input order', () => {
		const withOrder = (warnings: ConfigPlanWarning[]) =>
			serializeConfigPlan(emptyPlan(), {
				enrichment: { roleDeletionImpact: new Map(), warnings },
				manifestVersion: 1,
			}).warnings.map((entry) => entry.identity.role);

		expect(withOrder([warning('editor', 'a'), warning('author', 'b')])).toEqual(['author', 'editor']);
		expect(withOrder([warning('author', 'b'), warning('editor', 'a')])).toEqual(['author', 'editor']);
	});

	it('summary counts match the changes array', () => {
		const plan = emptyPlan();
		plan.roles.create.push(role('a'));
		plan.roles.update.push({ key: 'b', diff: { name: 'B' }, changes: { name: { before: 'x', after: 'B' } } });
		plan.permissions.delete.push({ roleKey: 'c', collection: 'x', action: 'read' });

		const result = serializeConfigPlan(plan, { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.summary).toEqual({ create: 1, update: 1, delete: 1 });
		expect(result.summary.create).toBe(result.changes.filter((change) => change.operation === 'create').length);
		expect(result.summary.update).toBe(result.changes.filter((change) => change.operation === 'update').length);
		expect(result.summary.delete).toBe(result.changes.filter((change) => change.operation === 'delete').length);
	});

	it('echoes the manifest version and the plan version', () => {
		const result = serializeConfigPlan(emptyPlan(), { enrichment: emptyEnrichment(), manifestVersion: 1 });

		expect(result.planVersion).toBe(1);
		expect(result.manifestVersion).toBe(1);
	});

	it('round-trips through JSON unchanged', () => {
		const plan = emptyPlan();
		plan.roles.create.push(role('a'));
		plan.roles.delete.push('z');

		plan.permissions.update.push({
			roleKey: 'a',
			permission: perm('articles', 'read'),
			changes: { fields: { before: null, after: ['title'] } },
		});

		const enrichment: ConfigPlanEnrichment = {
			roleDeletionImpact: new Map([['z', zeroImpact()]]),
			warnings: [warning('a', 'ghost')],
		};

		const result = serializeConfigPlan(plan, { enrichment, manifestVersion: 1 });

		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});
});
