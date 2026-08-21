import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSystemCache } from '../cache.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { DestructiveChangesRequiredException } from '../exceptions/destructive-changes-required.js';
import { applyConfigPlan } from './apply-config-plan.js';
import type { ConfigPlan } from '../types/config.js';

const { transactionSpy } = vi.hoisted(() => ({ transactionSpy: vi.fn() }));

const permissionsService = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn(), readByQuery: vi.fn() };
const rolesService = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };

let trxRows: Record<string, Array<Record<string, any>>> = {};

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

transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));

vi.mock('../database/index.js', () => ({
	default: () => ({ transaction: transactionSpy }),
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

describe('applyConfigPlan:destructive refusal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		trxRows = { directus_roles: [], directus_permissions: [] };
	});

	function mixedPlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		plan.roles.update.push({ key: 'viewer', changes: { name: { before: 'Viewer', after: 'Read Only' } } });
		plan.roles.delete.push('old_role');
		return plan;
	}

	it('refuses a plan with create, update, and delete work before opening the transaction', async () => {
		await expect(applyConfigPlan(mixedPlan(), {})).rejects.toBeInstanceOf(DestructiveChangesRequiredException);

		expect(transactionSpy).not.toHaveBeenCalled();
		expect(rolesService.createOne).not.toHaveBeenCalled();
		expect(rolesService.updateOne).not.toHaveBeenCalled();
		expect(rolesService.deleteOne).not.toHaveBeenCalled();
	});

	it('applies every create, update, and delete when destructive is set', async () => {
		trxRows = {
			directus_roles: [
				{ id: 'r-viewer', key: 'viewer' },
				{ id: 'r-old', key: 'old_role' },
			],
			directus_permissions: [],
		};

		await applyConfigPlan(mixedPlan(), { destructive: true });

		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(rolesService.createOne).toHaveBeenCalledTimes(1);
		expect(rolesService.updateOne).toHaveBeenCalledWith('r-viewer', { name: 'Read Only' });
		expect(rolesService.deleteOne).toHaveBeenCalledWith('r-old');
	});

	it('applies a deletion-free plan identically with and without the destructive flag', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		const withoutFlag = await applyConfigPlan(plan, {});
		const withFlag = await applyConfigPlan(plan, { destructive: true });

		expect(withoutFlag).toEqual(withFlag);
		expect(withoutFlag.roles.created).toEqual(['editor']);
	});

	it('reports both role and permission deletions in the refusal extensions', async () => {
		const plan = emptyPlan();
		plan.roles.delete.push('old_role');
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });

		const error = (await applyConfigPlan(plan, {}).catch((thrown) => thrown)) as DestructiveChangesRequiredException;

		expect(error).toBeInstanceOf(DestructiveChangesRequiredException);

		expect(error.extensions).toEqual({
			deletions: [
				{ kind: 'roles', identity: { key: 'old_role' } },
				{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			],
		});
	});

	it('writes canonicalized permission fields on create, matching the serialized plan', async () => {
		trxRows = { directus_roles: [{ id: 'r-editor', key: 'editor' }], directus_permissions: [] };

		const plan = emptyPlan();

		plan.permissions.create.push({
			roleKey: 'editor',
			permission: {
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: ['title', 'body'],
			},
		});

		await applyConfigPlan(plan, {});

		expect(permissionsService.createOne).toHaveBeenCalledWith(
			{
				role: 'r-editor',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: ['body', 'title'],
			},
			{ autoPurgeCache: false }
		);
	});
});

describe('applyConfigPlan:permission identity is resolved in the transaction', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Each competing row differs in one tuple member, so an incomplete predicate selects the wrong row.
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
			collection: 'articles',
			action: 'read',
			changes: { fields: { before: null, after: ['title'] } },
		});

		return plan;
	}

	it('updates the row found in the transaction even when a read hook hides it', async () => {
		permissionsService.readByQuery.mockResolvedValue([]);

		const result = await applyConfigPlan(updatePlan(), {});

		expect(result.permissions.updated).toBe(1);

		expect(permissionsService.updateOne).toHaveBeenCalledWith(
			'perm-real',
			{ fields: ['title'] },
			{ autoPurgeCache: false }
		);

		expect(permissionsService.readByQuery).not.toHaveBeenCalled();
	});

	it('does not let a read hook redirect the update at another row', async () => {
		permissionsService.readByQuery.mockResolvedValue([{ id: 'perm-attacker' }]);

		await applyConfigPlan(updatePlan(), {});

		expect(permissionsService.updateOne).toHaveBeenCalledWith(
			'perm-real',
			{ fields: ['title'] },
			{ autoPurgeCache: false }
		);

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

describe('applyConfigPlan:transaction failure wrapper', () => {
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
