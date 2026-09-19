import { describe, expect, it } from 'vitest';
import type { ConfigFolder, ConfigPermission, ConfigPlan, ConfigRole } from '../../types/config.js';
import { isPlanEmpty, planDeletions, planHasDeletions, planSummary } from './plan-folds.js';

function emptyPlan(): ConfigPlan {
	return {
		managedResources: [],
		roles: { create: [], update: [], delete: [] },
		permissions: { create: [], update: [], delete: [] },
		folders: { create: [], update: [], delete: [] },
		settings: { create: [], update: [], delete: [] },
		'extension-settings': { create: [], update: [], delete: [] },
		protections: [],
	};
}

const A_ROLE: ConfigRole = { key: 'x', name: 'X', admin_access: false, app_access: true };

const A_FOLDER: ConfigFolder = { key: 'x', name: 'X', parent: null };

const A_PERMISSION: ConfigPermission = {
	collection: 'c',
	action: 'read',
	permissions: null,
	validation: null,
	presets: null,
	fields: null,
};

const SLICE_MUTATIONS: Array<[string, (plan: ConfigPlan) => void]> = [
	['roles.create', (plan) => plan.roles.create.push(A_ROLE)],
	['roles.update', (plan) => plan.roles.update.push({ key: 'x', changes: {} })],
	['roles.delete', (plan) => plan.roles.delete.push('x')],
	['permissions.create', (plan) => plan.permissions.create.push({ roleKey: 'r', permission: A_PERMISSION })],
	[
		'permissions.update',
		(plan) => plan.permissions.update.push({ roleKey: 'r', collection: 'c', action: 'read', changes: {} }),
	],
	['permissions.delete', (plan) => plan.permissions.delete.push({ roleKey: 'r', collection: 'c', action: 'read' })],
	['folders.create', (plan) => plan.folders.create.push(A_FOLDER)],
	['folders.update', (plan) => plan.folders.update.push({ key: 'x', changes: {} })],
	['folders.delete', (plan) => plan.folders.delete.push('x')],
	['settings.update', (plan) => plan.settings.update.push({ changes: {} })],
];

describe('plan folds', () => {
	it('reports an empty plan', () => {
		expect(isPlanEmpty(emptyPlan())).toBe(true);
	});

	it.each(SLICE_MUTATIONS)('is not empty when %s has an entry', (_label, mutate) => {
		const plan = emptyPlan();
		mutate(plan);
		expect(isPlanEmpty(plan)).toBe(false);
	});

	it('summarizes an empty plan as zero counts', () => {
		expect(planSummary(emptyPlan())).toEqual({ create: 0, update: 0, delete: 0 });
	});

	it('counts create, update, and delete entries across every kind', () => {
		const plan = emptyPlan();
		for (const [, mutate] of SLICE_MUTATIONS) mutate(plan);
		plan.roles.delete.push('y');

		expect(planSummary(plan)).toEqual({ create: 3, update: 4, delete: 4 });
	});

	it('detects deletions in any kind', () => {
		expect(planHasDeletions(emptyPlan())).toBe(false);

		const withRole = emptyPlan();
		withRole.roles.delete.push('old');
		expect(planHasDeletions(withRole)).toBe(true);

		const withPermission = emptyPlan();
		withPermission.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });
		expect(planHasDeletions(withPermission)).toBe(true);

		const withFolder = emptyPlan();
		withFolder.folders.delete.push('old');
		expect(planHasDeletions(withFolder)).toBe(true);
	});

	it('projects each deletion to its identity, in kind order', () => {
		const plan = emptyPlan();
		plan.roles.delete.push('old');
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });
		plan.folders.delete.push('archive');

		expect(planDeletions(plan)).toEqual([
			{ kind: 'roles', identity: { key: 'old' } },
			{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			{ kind: 'folders', identity: { key: 'archive' } },
		]);
	});
});
