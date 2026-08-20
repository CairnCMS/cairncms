import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSystemCache } from '../cache.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { applyConfigPlan } from './apply-config-plan.js';
import type { ConfigPlan } from '../types/config.js';

const permissionsService = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn(), readByQuery: vi.fn() };
const rolesService = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };

let trxRows: Record<string, Array<Record<string, any>>> = {};

/** Applies `where`, so seeding competing rows proves a query selects by its full tuple. */
function trxStub(table: string): any {
	let rows = trxRows[table] ?? [];

	const chain: any = {
		select: () => chain,
		where: (predicate: Record<string, any>) => {
			rows = rows.filter((row) => Object.entries(predicate).every(([column, value]) => row[column] === value));
			return chain;
		},
		first: () => Promise.resolve(rows[0]),
		then: (onFulfilled: any, onRejected?: any) => Promise.resolve(rows).then(onFulfilled, onRejected),
	};

	return chain;
}

vi.mock('../database/index.js', () => ({
	default: () => ({ transaction: async (cb: any) => cb(trxStub) }),
}));

vi.mock('./get-schema.js', () => ({ getSchema: async () => ({ collections: {}, relations: [] }) }));
vi.mock('../cache.js', () => ({ clearSystemCache: vi.fn() }));
vi.mock('../services/permissions.js', () => ({ PermissionsService: vi.fn(() => permissionsService) }));
vi.mock('../services/roles.js', () => ({ RolesService: vi.fn(() => rolesService) }));

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

describe('applyConfigPlan — permission identity is resolved in the transaction', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Competing rows differ from the target by exactly one tuple member, so a query missing any part
		// of (role, collection, action) selects the wrong row.
		trxRows = {
			directus_roles: [
				{ id: 'role-1', key: 'editor' },
				{ id: 'role-2', key: 'viewer' },
			],
			directus_permissions: [
				{ id: 'perm-other-role', role: 'role-2', collection: 'articles', action: 'read' },
				{ id: 'perm-other-collection', role: 'role-1', collection: 'pages', action: 'read' },
				{ id: 'perm-other-action', role: 'role-1', collection: 'articles', action: 'update' },
				{ id: 'perm-real', role: 'role-1', collection: 'articles', action: 'read' },
			],
		};
	});

	function updatePlan(): ConfigPlan {
		const plan = emptyPlan();

		plan.permissions.update.push({
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

		return plan;
	}

	it('updates the row found in the transaction even when a read hook hides it', async () => {
		permissionsService.readByQuery.mockResolvedValue([]);

		const result = await applyConfigPlan(updatePlan(), {});

		expect(result.permissions.updated).toBe(1);
		expect(permissionsService.updateOne).toHaveBeenCalledWith('perm-real', expect.anything(), expect.anything());
		expect(permissionsService.readByQuery).not.toHaveBeenCalled();
	});

	it('does not let a read hook redirect the update at another row', async () => {
		permissionsService.readByQuery.mockResolvedValue([{ id: 'perm-attacker' }]);

		await applyConfigPlan(updatePlan(), {});

		expect(permissionsService.updateOne).toHaveBeenCalledWith('perm-real', expect.anything(), expect.anything());

		expect(permissionsService.updateOne).not.toHaveBeenCalledWith(
			'perm-attacker',
			expect.anything(),
			expect.anything()
		);
	});

	it('deletes the row found in the transaction even when a read hook hides it', async () => {
		permissionsService.readByQuery.mockResolvedValue([]);

		const plan = emptyPlan();
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });

		const result = await applyConfigPlan(plan, { destructive: true });

		expect(result.permissions.deleted).toBe(1);
		expect(permissionsService.deleteOne).toHaveBeenCalledWith('perm-real', expect.anything());
		expect(permissionsService.readByQuery).not.toHaveBeenCalled();
	});

	it('still reports a genuinely absent row as a failed update', async () => {
		trxRows['directus_permissions'] = trxRows['directus_permissions']!.filter((row) => row['id'] !== 'perm-real');

		await expect(applyConfigPlan(updatePlan(), {})).rejects.toBeInstanceOf(ConfigApplyFailedException);
	});
});

describe('applyConfigPlan — transaction failure wrapper', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		trxRows = {
			directus_roles: [{ id: 'role-1', key: 'editor' }],
			directus_permissions: [],
		};
	});

	function createPlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		return plan;
	}

	it('wraps a non-typed failure inside the transaction as CONFIG_APPLY_FAILED', async () => {
		rolesService.createOne.mockRejectedValueOnce(new Error('constraint violation'));

		const error = (await applyConfigPlan(createPlan(), {}).catch((thrown) => thrown)) as ConfigApplyFailedException;

		expect(error).toBeInstanceOf(ConfigApplyFailedException);
		expect(error.code).toBe('CONFIG_APPLY_FAILED');
		expect(error.status).toBe(500);
		expect(error.message).toContain('Retry the operation and report the failure if it persists');
		expect(error.message).not.toContain('constraint violation');
	});

	it('rethrows a typed failure from inside the transaction unchanged', async () => {
		const typed = new ConfigInvalidException('service rejected the record');
		rolesService.createOne.mockRejectedValueOnce(typed);

		await expect(applyConfigPlan(createPlan(), {})).rejects.toBe(typed);
	});

	it('does not wrap a post-commit cache failure as a rollback', async () => {
		vi.mocked(clearSystemCache).mockRejectedValueOnce(new Error('cache unavailable'));

		const error = (await applyConfigPlan(createPlan(), {}).catch((thrown) => thrown)) as Error;

		expect(error).not.toBeInstanceOf(ConfigApplyFailedException);
		expect(error.message).toContain('cache unavailable');
	});
});
