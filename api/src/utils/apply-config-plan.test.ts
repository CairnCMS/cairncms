import type { Accountability } from '@cairncms/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushCaches } from '../cache.js';
import emitter from '../emitter.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigPostCommitFailedException } from '../exceptions/config-post-commit-failed.js';
import { DestructiveChangesRequiredException } from '../exceptions/destructive-changes-required.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import { applyConfigPlan } from './apply-config-plan.js';
import type { ConfigApplySecurityContext, ConfigPlan } from '../types/config.js';

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
vi.mock('../cache.js', () => ({ clearSystemCache: vi.fn(), flushCaches: vi.fn() }));
vi.mock('../emitter.js', () => ({ default: { emitActionAndWait: vi.fn() } }));
vi.mock('../services/permissions.js', () => ({ PermissionsService: vi.fn(() => permissionsService) }));
vi.mock('../services/roles.js', () => ({ RolesService: vi.fn(() => rolesService) }));

const accountability = {
	user: null,
	role: null,
	admin: true,
	app: true,
	permissions: [],
	origin: 'config-cli',
} satisfies Accountability;

const context: ConfigApplySecurityContext = {
	mode: 'system',
	reason: 'local config apply',
	accountability,
};

const forwardedOptions = () =>
	expect.objectContaining({
		autoPurgeCache: false,
		autoPurgeSystemCache: false,
		bypassEmitAction: expect.any(Function),
		bypassLimits: true,
	});

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
		await expect(applyConfigPlan(mixedPlan(), { context })).rejects.toBeInstanceOf(DestructiveChangesRequiredException);

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

		await applyConfigPlan(mixedPlan(), { destructive: true, context });

		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(rolesService.createOne).toHaveBeenCalledTimes(1);
		expect(rolesService.createOne).toHaveBeenCalledWith(expect.objectContaining({ key: 'editor' }), forwardedOptions());
		expect(rolesService.updateOne).toHaveBeenCalledWith('r-viewer', { name: 'Read Only' }, forwardedOptions());
		expect(rolesService.deleteOne).toHaveBeenCalledWith('r-old', forwardedOptions());
	});

	it('constructs both services with the caller accountability', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		await applyConfigPlan(plan, { context });

		expect(RolesService).toHaveBeenCalledWith(expect.objectContaining({ accountability: context.accountability }));

		expect(PermissionsService).toHaveBeenCalledWith(
			expect.objectContaining({ accountability: context.accountability })
		);
	});

	it('applies a deletion-free plan identically with and without the destructive flag', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		const withoutFlag = await applyConfigPlan(plan, { context });
		const withFlag = await applyConfigPlan(plan, { destructive: true, context });

		expect(withoutFlag).toEqual(withFlag);
		expect(withoutFlag.roles.created).toEqual(['editor']);
	});

	it('reports both role and permission deletions in the refusal extensions', async () => {
		const plan = emptyPlan();
		plan.roles.delete.push('old_role');
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });

		const error = (await applyConfigPlan(plan, { context }).catch(
			(thrown) => thrown
		)) as DestructiveChangesRequiredException;

		expect(error).toBeInstanceOf(DestructiveChangesRequiredException);

		expect(error.extensions).toEqual({
			deletions: [
				{ kind: 'roles', identity: { key: 'old_role' } },
				{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			],
		});
	});

	it('writes canonicalized permission fields on create with the forwarded options', async () => {
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

		await applyConfigPlan(plan, { context });

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
			forwardedOptions()
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

		const result = await applyConfigPlan(updatePlan(), { context });

		expect(result.permissions.updated).toBe(1);

		expect(permissionsService.updateOne).toHaveBeenCalledWith('perm-real', { fields: ['title'] }, forwardedOptions());

		expect(permissionsService.readByQuery).not.toHaveBeenCalled();
	});

	it('does not let a read hook redirect the update at another row', async () => {
		permissionsService.readByQuery.mockResolvedValue([{ id: 'perm-attacker' }]);

		await applyConfigPlan(updatePlan(), { context });

		expect(permissionsService.updateOne).toHaveBeenCalledWith('perm-real', { fields: ['title'] }, forwardedOptions());

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

		const result = await applyConfigPlan(plan, { destructive: true, context });

		expect(result.permissions.deleted).toBe(1);
		expect(permissionsService.deleteOne).toHaveBeenCalledWith('perm-real', forwardedOptions());
		expect(permissionsService.readByQuery).not.toHaveBeenCalled();
	});

	it('still reports a genuinely absent row as a failed update', async () => {
		trxRows['directus_permissions'] = trxRows['directus_permissions']!.filter((row) => row['id'] !== 'perm-real');

		await expect(applyConfigPlan(updatePlan(), { context })).rejects.toBeInstanceOf(ConfigApplyFailedException);
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

		const error = (await applyConfigPlan(createPlan(), { context }).catch(
			(thrown) => thrown
		)) as ConfigApplyFailedException;

		expect(error).toBeInstanceOf(ConfigApplyFailedException);
		expect(error.code).toBe('CONFIG_APPLY_FAILED');
		expect(error.status).toBe(500);
		expect(error.message).toContain('Retry the operation and report the failure if it persists');
		expect(error.message).not.toContain('constraint violation');
	});

	it('rethrows a typed failure from inside the transaction unchanged', async () => {
		const typed = new ConfigInvalidException('service rejected the record');
		rolesService.createOne.mockRejectedValueOnce(typed);

		await expect(applyConfigPlan(createPlan(), { context })).rejects.toBe(typed);
	});

	it('reports a post-commit cache failure as CONFIG_POST_COMMIT_FAILED, not a rollback', async () => {
		vi.mocked(flushCaches).mockRejectedValueOnce(new Error('cache unavailable'));

		const error = (await applyConfigPlan(createPlan(), { context }).catch(
			(thrown) => thrown
		)) as ConfigPostCommitFailedException;

		expect(error).toBeInstanceOf(ConfigPostCommitFailedException);
		expect(error).not.toBeInstanceOf(ConfigApplyFailedException);
		expect(error.status).toBe(500);
		expect(error.code).toBe('CONFIG_POST_COMMIT_FAILED');
		expect(error.extensions).toEqual({ committed: true, phase: 'cache' });
		expect(error.message).toContain('/utils/cache/clear');
		expect(error.message).not.toContain('cache unavailable');
	});

	it('wraps a commit failure as CONFIG_APPLY_FAILED without raw detail, and does not flush or dispatch', async () => {
		transactionSpy.mockImplementationOnce(async (cb: any) => {
			await cb(trxStub);
			throw new Error('commit deadlock');
		});

		const error = (await applyConfigPlan(createPlan(), { context }).catch(
			(thrown) => thrown
		)) as ConfigApplyFailedException;

		expect(error).toBeInstanceOf(ConfigApplyFailedException);
		expect(error.message).not.toContain('commit deadlock');
		expect(flushCaches).not.toHaveBeenCalled();
		expect(emitter.emitActionAndWait).not.toHaveBeenCalled();
	});
});

describe('applyConfigPlan:post-commit ordering', () => {
	const order: string[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		order.length = 0;
		trxRows = { directus_roles: [], directus_permissions: [] };

		transactionSpy.mockImplementation(async (cb: any) => {
			const result = await cb(trxStub);
			order.push('commit');
			return result;
		});

		vi.mocked(flushCaches).mockImplementation(async () => {
			order.push('flush');
		});

		vi.mocked(emitter.emitActionAndWait).mockImplementation(async () => {
			order.push('dispatch');
		});

		rolesService.createOne.mockImplementation(async (_data: any, opts: any) => {
			order.push('mutate');
			opts?.bypassEmitAction?.({ event: 'roles.create', meta: { key: 'editor' }, context: { probe: true } });
			return 'editor';
		});
	});

	function createPlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		return plan;
	}

	it('commits, then flushes, then dispatches on a successful apply', async () => {
		await applyConfigPlan(createPlan(), { context });

		expect(order).toEqual(['mutate', 'commit', 'flush', 'dispatch']);
		expect(flushCaches).toHaveBeenCalledTimes(1);
	});

	it('passes the queued event metadata to emitActionAndWait unchanged', async () => {
		await applyConfigPlan(createPlan(), { context });

		expect(emitter.emitActionAndWait).toHaveBeenCalledWith('roles.create', { key: 'editor' }, { probe: true });
	});

	it('dispatches the committed events before raising the typed failure when the flush fails', async () => {
		vi.mocked(flushCaches).mockImplementation(async () => {
			order.push('flush');
			throw new Error('cache down');
		});

		const error = (await applyConfigPlan(createPlan(), { context }).catch((thrown) => thrown)) as Error;

		expect(order).toEqual(['mutate', 'commit', 'flush', 'dispatch']);
		expect(emitter.emitActionAndWait).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(ConfigPostCommitFailedException);
	});

	it('discards queued events and neither commits, flushes, nor dispatches when a later mutation fails', async () => {
		rolesService.createOne
			.mockImplementationOnce(async (_data: any, opts: any) => {
				order.push('mutate');
				opts?.bypassEmitAction?.({ event: 'roles.create', meta: {}, context: {} });
				return 'editor';
			})
			.mockImplementationOnce(async () => {
				throw new Error('constraint');
			});

		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		plan.roles.create.push({ key: 'later', name: 'Later', admin_access: false, app_access: true });

		await expect(applyConfigPlan(plan, { context })).rejects.toBeInstanceOf(ConfigApplyFailedException);

		expect(order).toEqual(['mutate']);
		expect(flushCaches).not.toHaveBeenCalled();
		expect(emitter.emitActionAndWait).not.toHaveBeenCalled();
	});
});
