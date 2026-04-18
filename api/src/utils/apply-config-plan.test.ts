import { describe, expect, it } from 'vitest';
import { applyConfigPlan } from './apply-config-plan.js';
import type { ConfigPlan } from '../types/config.js';

function emptyPlan(): ConfigPlan {
	return {
		roles: { create: [], update: [], delete: [] },
		permissions: { create: [], update: [], delete: [] },
	};
}

describe('applyConfigPlan — dryRun', () => {
	it('returns empty result for empty plan', async () => {
		const result = await applyConfigPlan(emptyPlan(), { dryRun: true });

		expect(result.roles.created).toEqual([]);
		expect(result.roles.updated).toEqual([]);
		expect(result.roles.deleted).toEqual([]);
		expect(result.permissions.created).toBe(0);
		expect(result.permissions.updated).toBe(0);
		expect(result.permissions.deleted).toBe(0);
	});

	it('reports planned role creates and updates', async () => {
		const plan = emptyPlan();

		plan.roles.create.push({
			key: 'editor',
			name: 'Editor',
			admin_access: false,
			app_access: true,
		});

		plan.roles.update.push({
			key: 'viewer',
			diff: { name: 'Read-Only' },
		});

		const result = await applyConfigPlan(plan, { dryRun: true });

		expect(result.roles.created).toEqual(['editor']);
		expect(result.roles.updated).toEqual(['viewer']);
	});

	it('reports planned permission creates and updates', async () => {
		const plan = emptyPlan();

		plan.permissions.create.push({
			roleKey: 'editor',
			permission: {
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		plan.permissions.update.push({
			roleKey: 'editor',
			permission: {
				collection: 'articles',
				action: 'update',
				permissions: null,
				validation: null,
				presets: null,
				fields: ['title'],
			},
		});

		const result = await applyConfigPlan(plan, { dryRun: true });

		expect(result.permissions.created).toBe(1);
		expect(result.permissions.updated).toBe(1);
	});

	it('only reports deletions when destructive is true', async () => {
		const plan = emptyPlan();
		plan.roles.delete.push('old_role');
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'delete' });

		const nonDestructive = await applyConfigPlan(plan, { dryRun: true });
		expect(nonDestructive.roles.deleted).toEqual([]);
		expect(nonDestructive.permissions.deleted).toBe(0);

		const destructive = await applyConfigPlan(plan, { dryRun: true, destructive: true });
		expect(destructive.roles.deleted).toEqual(['old_role']);
		expect(destructive.permissions.deleted).toBe(1);
	});

	it('does not count permission deletes for roles being deleted', async () => {
		const plan = emptyPlan();
		plan.roles.delete.push('editor');

		plan.permissions.delete.push(
			{ roleKey: 'editor', collection: 'articles', action: 'read' },
			{ roleKey: 'editor', collection: 'articles', action: 'update' },
			{ roleKey: 'viewer', collection: 'pages', action: 'read' }
		);

		const result = await applyConfigPlan(plan, { dryRun: true, destructive: true });

		expect(result.roles.deleted).toEqual(['editor']);
		expect(result.permissions.deleted).toBe(1);
	});

	it('handles public permission creates in dry run', async () => {
		const plan = emptyPlan();

		plan.permissions.create.push({
			roleKey: 'public',
			permission: {
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		const result = await applyConfigPlan(plan, { dryRun: true });
		expect(result.permissions.created).toBe(1);
	});

	it('handles public permission deletes in destructive dry run', async () => {
		const plan = emptyPlan();

		plan.permissions.delete.push({ roleKey: 'public', collection: 'articles', action: 'read' });

		const result = await applyConfigPlan(plan, { dryRun: true, destructive: true });
		expect(result.permissions.deleted).toBe(1);
	});
});
