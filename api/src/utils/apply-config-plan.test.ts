import type { Accountability, EventContext, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushCaches } from '../cache.js';
import emitter from '../emitter.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { ConfigApplyScopeMismatchException } from '../exceptions/config-apply-scope-mismatch.js';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigPostCommitFailedException } from '../exceptions/config-post-commit-failed.js';
import { ConfigProtectedRecordException } from '../exceptions/config-protected-record.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import { ConfigStateChangedException } from '../exceptions/config-state-changed.js';
import { DestructiveChangesRequiredException } from '../exceptions/destructive-changes-required.js';
import getDatabase from '../database/index.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import { applyConfigPlan as runApplyConfigPlan } from './apply-config-plan.js';
import type { ApplyContext, ConfigApplyMutationOptions, ConfigKindTypes } from './config/descriptor.js';
import { CONFIG_REGISTRY, getDescriptor } from './config/registry.js';
import { getSchema } from './get-schema.js';
import type { ActionEventParams } from '../types/index.js';
import type { ConfigApplySecurityContext, ConfigKind, ConfigPlan, ConfigStateToken } from '../types/config.js';

const { transactionSpy, readCurrentConfigMock } = vi.hoisted(() => ({
	transactionSpy: vi.fn(),
	readCurrentConfigMock: vi.fn(),
}));

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
	default: vi.fn(() => ({ transaction: transactionSpy })),
	getDatabaseClient: vi.fn(() => 'postgres'),
}));

vi.mock('./get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {}, relations: [] })) }));
vi.mock('./get-config-snapshot.js', () => ({ readCurrentConfig: readCurrentConfigMock }));
vi.mock('../cache.js', () => ({ clearSystemCache: vi.fn(), flushCaches: vi.fn() }));
vi.mock('../emitter.js', () => ({ default: { emitActionAndWait: vi.fn() } }));
vi.mock('../services/permissions.js', () => ({ PermissionsService: vi.fn(() => permissionsService) }));
vi.mock('../services/roles.js', () => ({ RolesService: vi.fn(() => rolesService) }));

const STATE_TOKEN: ConfigStateToken = { resources: ['permissions', 'roles'], digest: 'digest-current' };

readCurrentConfigMock.mockImplementation(async () => ({
	config: { manifest: { version: 1, resources: ['permissions', 'roles'] }, roles: [], permissions: [] },
	currentRoleKeys: new Set<string>(),
	stateToken: STATE_TOKEN,
}));

function applyConfigPlan(
	plan: ConfigPlan,
	opts: Omit<Parameters<typeof runApplyConfigPlan>[1], 'expectedStateToken'> & { expectedStateToken?: ConfigStateToken }
): Promise<Awaited<ReturnType<typeof runApplyConfigPlan>>> {
	return runApplyConfigPlan(plan, { expectedStateToken: STATE_TOKEN, ...opts });
}

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

const suppliedSchema: SchemaOverview = { collections: {}, relations: [] };

const eventContext: EventContext = { database: trxStub as unknown as Knex, schema: suppliedSchema, accountability };

const actionEvent = (event: string, meta: Record<string, unknown>): ActionEventParams => ({
	event,
	meta,
	context: eventContext,
});

function emptyPlan(): ConfigPlan {
	return {
		managedResources: ['permissions', 'roles'],
		roles: { create: [], update: [], delete: [] },
		permissions: { create: [], update: [], delete: [] },
		protections: [],
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

	it('constructs RolesService against the transaction, supplied schema, and caller accountability for role work', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		await applyConfigPlan(plan, { schema: suppliedSchema, context });

		expect(RolesService).toHaveBeenCalledTimes(1);

		const arg = vi.mocked(RolesService).mock.calls[0]![0];
		expect(arg.knex).toBe(trxStub);
		expect(arg.schema).toBe(suppliedSchema);
		expect(arg.accountability).toBe(context.accountability);

		expect(PermissionsService).not.toHaveBeenCalled();
	});

	it('constructs PermissionsService against the transaction, supplied schema, and caller accountability for permission work', async () => {
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
				fields: null,
			},
		});

		await applyConfigPlan(plan, { schema: suppliedSchema, context });

		expect(PermissionsService).toHaveBeenCalledTimes(1);

		const arg = vi.mocked(PermissionsService).mock.calls[0]![0];
		expect(arg.knex).toBe(trxStub);
		expect(arg.schema).toBe(suppliedSchema);
		expect(arg.accountability).toBe(context.accountability);

		expect(RolesService).not.toHaveBeenCalled();
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

describe('applyConfigPlan:serialization conflict mapping', () => {
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

	const driverConflicts: Array<[string, Record<string, unknown>]> = [
		['PostgreSQL serialization_failure', { code: '40001' }],
		['PostgreSQL deadlock_detected', { code: '40P01' }],
		['InnoDB deadlock', { errno: 1213, sqlState: '40001' }],
	];

	it.each(driverConflicts)(
		'maps a %s at commit to CONFIG_STATE_CHANGED after the callback queued an effect, with no flush or dispatch',
		async (_label, driverProps) => {
			rolesService.createOne.mockImplementationOnce(async (_data: unknown, opts: any) => {
				opts?.bypassEmitAction?.({ event: 'roles.create', meta: {}, context: {} });
				return 'role-1';
			});

			transactionSpy.mockImplementationOnce(async (cb: any) => {
				await cb(trxStub);
				throw Object.assign(new Error('driver serialization failure'), driverProps);
			});

			const error = (await applyConfigPlan(createPlan(), { context }).catch((thrown) => thrown)) as Error;

			expect(error).toBeInstanceOf(ConfigStateChangedException);
			expect(rolesService.createOne).toHaveBeenCalledTimes(1);
			expect(flushCaches).not.toHaveBeenCalled();
			expect(emitter.emitActionAndWait).not.toHaveBeenCalled();
		}
	);

	it('opens the apply transaction at the serializable isolation level', async () => {
		await applyConfigPlan(createPlan(), { context });

		expect(transactionSpy).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
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

	it('forces the post-commit system cache clear so the debounce lock cannot skip it', async () => {
		await applyConfigPlan(createPlan(), { context });

		expect(flushCaches).toHaveBeenCalledWith(true);
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

describe('applyConfigPlan:engine schedule', () => {
	const order: string[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		order.length = 0;
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));

		trxRows = {
			directus_roles: [
				{ id: 'r-viewer', key: 'viewer' },
				{ id: 'r-guest', key: 'guest' },
				{ id: 'r-old1', key: 'old_one' },
				{ id: 'r-old2', key: 'old_two' },
				{ id: 'r-writer', key: 'writer' },
			],
			directus_permissions: [
				{ id: 'p-au', role: 'r-writer', collection: 'articles', action: 'update' },
				{ id: 'p-pu', role: 'r-writer', collection: 'pages', action: 'update' },
				{ id: 'p-ad', role: 'r-writer', collection: 'articles', action: 'delete' },
				{ id: 'p-pd', role: 'r-writer', collection: 'pages', action: 'delete' },
			],
		};

		rolesService.createOne.mockImplementation(async (data: { key: string }) => {
			order.push(`role:create:${data.key}`);
			return data.key;
		});

		rolesService.updateOne.mockImplementation(async (id: string) => {
			order.push(`role:update:${id}`);
			return id;
		});

		rolesService.deleteOne.mockImplementation(async (id: string) => {
			order.push(`role:delete:${id}`);
			return id;
		});

		permissionsService.createOne.mockImplementation(async (data: { action: string }) => {
			order.push(`perm:create:${data.action}`);
			return `new-${data.action}`;
		});

		permissionsService.updateOne.mockImplementation(async (id: string) => {
			order.push(`perm:update:${id}`);
			return id;
		});

		permissionsService.deleteOne.mockImplementation(async (id: string) => {
			order.push(`perm:delete:${id}`);
			return id;
		});
	});

	function finalizedMixedPlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		plan.roles.create.push({ key: 'author', name: 'Author', admin_access: false, app_access: true });
		plan.roles.update.push({ key: 'viewer', changes: { name: { before: 'V', after: 'Viewer' } } });
		plan.roles.update.push({ key: 'guest', changes: { name: { before: 'G', after: 'Guest' } } });
		plan.roles.delete.push('old_one');
		plan.roles.delete.push('old_two');

		plan.permissions.create.push({
			roleKey: 'writer',
			permission: {
				collection: 'items',
				action: 'create',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		plan.permissions.create.push({
			roleKey: 'writer',
			permission: {
				collection: 'items',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		plan.permissions.update.push({
			roleKey: 'writer',
			collection: 'articles',
			action: 'update',
			changes: { fields: { before: null, after: ['title'] } },
		});

		plan.permissions.update.push({
			roleKey: 'writer',
			collection: 'pages',
			action: 'update',
			changes: { fields: { before: null, after: ['body'] } },
		});

		plan.permissions.delete.push({ roleKey: 'writer', collection: 'articles', action: 'delete' });
		plan.permissions.delete.push({ roleKey: 'writer', collection: 'pages', action: 'delete' });
		return plan;
	}

	it('runs every create then every update in dependency order, then every delete in reverse dependency order', async () => {
		await applyConfigPlan(finalizedMixedPlan(), { destructive: true, context });

		expect(order).toEqual([
			'role:create:editor',
			'role:create:author',
			'role:update:r-viewer',
			'role:update:r-guest',
			'perm:create:create',
			'perm:create:read',
			'perm:update:p-au',
			'perm:update:p-pu',
			'perm:delete:p-ad',
			'perm:delete:p-pd',
			'role:delete:r-old1',
			'role:delete:r-old2',
		]);
	});

	it('returns a result folded from each kind outcome', async () => {
		const result = await applyConfigPlan(finalizedMixedPlan(), { destructive: true, context });

		expect(result).toEqual({
			roles: { created: ['editor', 'author'], updated: ['viewer', 'guest'], deleted: ['old_one', 'old_two'] },
			permissions: { created: 2, updated: 2, deleted: 2 },
		});
	});
});

describe('applyConfigPlan:events and post-commit ordering', () => {
	const order: string[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		order.length = 0;

		trxRows = {
			directus_roles: [
				{ id: 'r-viewer', key: 'viewer' },
				{ id: 'r-old', key: 'old_role' },
				{ id: 'r-writer', key: 'writer' },
			],
			directus_permissions: [
				{ id: 'p-au', role: 'r-writer', collection: 'articles', action: 'update' },
				{ id: 'p-pd', role: 'r-writer', collection: 'pages', action: 'read' },
			],
		};

		transactionSpy.mockImplementation(async (cb: any) => {
			const result = await cb(trxStub);
			order.push('commit');
			return result;
		});

		vi.mocked(flushCaches).mockImplementation(async () => {
			order.push('flush');
		});

		vi.mocked(emitter.emitActionAndWait).mockImplementation(async (event: string | string[]) => {
			order.push(`dispatch:${event}`);
		});

		rolesService.createOne.mockImplementation(async (_data: unknown, opts: ConfigApplyMutationOptions) => {
			order.push('mutate:role:create');
			opts.bypassEmitAction(actionEvent('roles.create', { key: 'editor' }));
			return 'editor';
		});

		rolesService.updateOne.mockImplementation(async (id: string, _data: unknown, opts: ConfigApplyMutationOptions) => {
			order.push('mutate:role:update');
			opts.bypassEmitAction(actionEvent('roles.update', { key: 'viewer' }));
			return id;
		});

		permissionsService.createOne.mockImplementation(async (_data: unknown, opts: ConfigApplyMutationOptions) => {
			order.push('mutate:perm:create');
			opts.bypassEmitAction(actionEvent('permissions.create', { collection: 'items' }));
			return 1;
		});

		permissionsService.updateOne.mockImplementation(
			async (id: string, _data: unknown, opts: ConfigApplyMutationOptions) => {
				order.push('mutate:perm:update');
				opts.bypassEmitAction(actionEvent('permissions.update', { collection: 'articles' }));
				return id;
			}
		);

		rolesService.deleteOne.mockImplementation(async (_id: string, opts: ConfigApplyMutationOptions) => {
			order.push('mutate:role:delete');
			opts.bypassEmitAction(actionEvent('permissions.delete', { cascade: true }));
			opts.bypassEmitAction(actionEvent('roles.delete', { key: 'old_role' }));
			return 'old_role';
		});

		permissionsService.deleteOne.mockImplementation(async (_id: string, opts: ConfigApplyMutationOptions) => {
			order.push('mutate:perm:delete');
			opts.bypassEmitAction(actionEvent('permissions.delete', { standalone: true }));
			return 1;
		});
	});

	function cascadePlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		plan.roles.update.push({ key: 'viewer', changes: { name: { before: 'V', after: 'Viewer' } } });
		plan.roles.delete.push('old_role');

		plan.permissions.create.push({
			roleKey: 'writer',
			permission: {
				collection: 'items',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		plan.permissions.update.push({
			roleKey: 'writer',
			collection: 'articles',
			action: 'update',
			changes: { fields: { before: null, after: ['title'] } },
		});

		plan.permissions.delete.push({ roleKey: 'writer', collection: 'pages', action: 'read' });
		return plan;
	}

	it('queues create, update, and delete events across kinds and dispatches them after commit and cache flush', async () => {
		await applyConfigPlan(cascadePlan(), { destructive: true, context });

		expect(order).toEqual([
			'mutate:role:create',
			'mutate:role:update',
			'mutate:perm:create',
			'mutate:perm:update',
			'mutate:perm:delete',
			'mutate:role:delete',
			'commit',
			'flush',
			'dispatch:roles.create',
			'dispatch:roles.update',
			'dispatch:permissions.create',
			'dispatch:permissions.update',
			'dispatch:permissions.delete',
			'dispatch:permissions.delete',
			'dispatch:roles.delete',
		]);
	});

	it('dispatches each queued event with its metadata, standalone permission-delete before the role-delete and its cascade', async () => {
		await applyConfigPlan(cascadePlan(), { destructive: true, context });

		expect(emitter.emitActionAndWait).toHaveBeenNthCalledWith(2, 'roles.update', { key: 'viewer' }, eventContext);

		expect(emitter.emitActionAndWait).toHaveBeenNthCalledWith(
			4,
			'permissions.update',
			{ collection: 'articles' },
			eventContext
		);

		expect(emitter.emitActionAndWait).toHaveBeenNthCalledWith(
			5,
			'permissions.delete',
			{ standalone: true },
			eventContext
		);

		expect(emitter.emitActionAndWait).toHaveBeenNthCalledWith(6, 'permissions.delete', { cascade: true }, eventContext);
		expect(emitter.emitActionAndWait).toHaveBeenNthCalledWith(7, 'roles.delete', { key: 'old_role' }, eventContext);
	});
});

describe('applyConfigPlan:mutation payloads', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));

		trxRows = {
			directus_roles: [
				{ id: 'r-viewer', key: 'viewer' },
				{ id: 'r-writer', key: 'writer' },
			],
			directus_permissions: [{ id: 'p-au', role: 'r-writer', collection: 'articles', action: 'update' }],
		};
	});

	it('writes the exact canonical create payload and the exact multi-field update payloads', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		plan.roles.update.push({
			key: 'viewer',
			changes: { name: { before: 'V', after: 'Viewer' }, enforce_tfa: { before: false, after: true } },
		});

		plan.permissions.update.push({
			roleKey: 'writer',
			collection: 'articles',
			action: 'update',
			changes: {
				fields: { before: null, after: ['body', 'title'] },
				presets: { before: null, after: { status: 'draft' } },
			},
		});

		await applyConfigPlan(plan, { context });

		expect(rolesService.createOne).toHaveBeenCalledWith(
			{
				key: 'editor',
				name: 'Editor',
				icon: 'supervised_user_circle',
				description: null,
				admin_access: false,
				app_access: true,
				enforce_tfa: false,
				ip_access: null,
			},
			expect.anything()
		);

		expect(rolesService.updateOne).toHaveBeenCalledWith(
			'r-viewer',
			{ name: 'Viewer', enforce_tfa: true },
			expect.anything()
		);

		expect(permissionsService.updateOne).toHaveBeenCalledWith(
			'p-au',
			{ fields: ['body', 'title'], presets: { status: 'draft' } },
			expect.anything()
		);
	});
});

describe('applyConfigPlan:role-state refresh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));
		trxRows = { directus_roles: [], directus_permissions: [] };

		rolesService.createOne.mockImplementation(async (data: { key: string }) => {
			const id = `r-${data.key}`;
			trxRows['directus_roles']!.push({ id, key: data.key });
			return id;
		});
	});

	it('reads role state after role creation so a permission can target the newly created role', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		plan.permissions.create.push({
			roleKey: 'editor',
			permission: {
				collection: 'items',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		const result = await applyConfigPlan(plan, { context });

		expect(permissionsService.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ role: 'r-editor' }),
			expect.anything()
		);

		expect(result).toEqual({
			roles: { created: ['editor'], updated: [], deleted: [] },
			permissions: { created: 1, updated: 0, deleted: 0 },
		});
	});
});

describe('applyConfigPlan:per-operation handler dispatch', () => {
	const spies: Array<{ mockRestore: () => void }> = [];

	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));

		trxRows = {
			directus_roles: [
				{ id: 'r-viewer', key: 'viewer' },
				{ id: 'r-old', key: 'old_role' },
			],
			directus_permissions: [],
		};

		rolesService.createOne.mockResolvedValue('editor');
		rolesService.updateOne.mockResolvedValue('r-viewer');
		rolesService.deleteOne.mockResolvedValue('r-old');
	});

	afterEach(() => {
		while (spies.length) spies.pop()!.mockRestore();
	});

	const cases = [
		{
			method: 'applyCreates',
			destructive: false,
			build: (plan: ConfigPlan) =>
				plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true }),
		},
		{
			method: 'applyUpdates',
			destructive: false,
			build: (plan: ConfigPlan) =>
				plan.roles.update.push({ key: 'viewer', changes: { name: { before: 'V', after: 'Viewer' } } }),
		},
		{
			method: 'applyDeletes',
			destructive: true,
			build: (plan: ConfigPlan) => plan.roles.delete.push('old_role'),
		},
	] as const;

	it.each(cases)(
		'a plan with only $method work invokes only the roles handler.$method',
		async ({ method, destructive, build }) => {
			const handler = getDescriptor('roles').handler;
			const applyCreates = vi.spyOn(handler, 'applyCreates');
			const applyUpdates = vi.spyOn(handler, 'applyUpdates');
			const applyDeletes = vi.spyOn(handler, 'applyDeletes');
			spies.push(applyCreates, applyUpdates, applyDeletes);

			const byMethod = { applyCreates, applyUpdates, applyDeletes };

			const plan = emptyPlan();
			build(plan);

			await applyConfigPlan(plan, { destructive, context });

			for (const candidate of ['applyCreates', 'applyUpdates', 'applyDeletes'] as const) {
				if (candidate === method) {
					expect(byMethod[candidate]).toHaveBeenCalledTimes(1);
				} else {
					expect(byMethod[candidate]).not.toHaveBeenCalled();
				}
			}
		}
	);
});

describe('applyConfigPlan:empty operations touch nothing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function poison<K extends ConfigKindTypes>(): ApplyContext<K> {
		return {
			get database(): never {
				throw new Error('touched database');
			},
			get schema(): never {
				throw new Error('touched schema');
			},
			get securityContext(): never {
				throw new Error('touched securityContext');
			},
			get mutationOptions(): never {
				throw new Error('touched mutationOptions');
			},
			dependency: <D extends Extract<keyof K['ApplyDependencies'], ConfigKind>>(_kind: D): never => {
				throw new Error('touched dependency');
			},
		};
	}

	const cases = [
		{
			name: 'roles.applyCreates',
			run: () => getDescriptor('roles').handler.applyCreates([], poison()),
			outcome: { op: 'create', created: [] },
		},
		{
			name: 'roles.applyUpdates',
			run: () => getDescriptor('roles').handler.applyUpdates([], poison()),
			outcome: { op: 'update', updated: [] },
		},
		{
			name: 'roles.applyDeletes',
			run: () => getDescriptor('roles').handler.applyDeletes([], poison()),
			outcome: { op: 'delete', deleted: [] },
		},
		{
			name: 'permissions.applyCreates',
			run: () => getDescriptor('permissions').handler.applyCreates([], poison()),
			outcome: { op: 'create', count: 0 },
		},
		{
			name: 'permissions.applyUpdates',
			run: () => getDescriptor('permissions').handler.applyUpdates([], poison()),
			outcome: { op: 'update', count: 0 },
		},
		{
			name: 'permissions.applyDeletes',
			run: () => getDescriptor('permissions').handler.applyDeletes([], poison()),
			outcome: { op: 'delete', count: 0 },
		},
	];

	it.each(cases)(
		'$name returns its empty outcome for an empty slice without touching context or constructing a service',
		async ({ run, outcome }) => {
			const result = await run();

			expect(result).toEqual(outcome);
			expect(RolesService).not.toHaveBeenCalled();
			expect(PermissionsService).not.toHaveBeenCalled();
		}
	);
});

describe('applyConfigPlan:mutation options', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));

		trxRows = {
			directus_roles: [
				{ id: 'r-viewer', key: 'viewer' },
				{ id: 'r-old', key: 'old_role' },
				{ id: 'r-writer', key: 'writer' },
			],
			directus_permissions: [
				{ id: 'p-au', role: 'r-writer', collection: 'articles', action: 'update' },
				{ id: 'p-del', role: 'r-writer', collection: 'pages', action: 'read' },
			],
		};

		rolesService.createOne.mockResolvedValue('editor');
		rolesService.updateOne.mockResolvedValue('r-viewer');
		rolesService.deleteOne.mockResolvedValue('r-old');
		permissionsService.createOne.mockResolvedValue(1);
		permissionsService.updateOne.mockResolvedValue('p-au');
		permissionsService.deleteOne.mockResolvedValue('p-del');
	});

	it('builds one options object with exactly the four intended fields and forwards that reference to every operation method', async () => {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });
		plan.roles.update.push({ key: 'viewer', changes: { name: { before: 'V', after: 'Viewer' } } });
		plan.roles.delete.push('old_role');

		plan.permissions.create.push({
			roleKey: 'writer',
			permission: {
				collection: 'items',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		});

		plan.permissions.update.push({
			roleKey: 'writer',
			collection: 'articles',
			action: 'update',
			changes: { fields: { before: null, after: ['title'] } },
		});

		plan.permissions.delete.push({ roleKey: 'writer', collection: 'pages', action: 'read' });

		await applyConfigPlan(plan, { destructive: true, context });

		const options = rolesService.createOne.mock.calls[0]![1];

		expect(options).toEqual({
			autoPurgeCache: false,
			autoPurgeSystemCache: false,
			bypassLimits: true,
			bypassEmitAction: expect.any(Function),
		});

		expect(Object.keys(options).sort()).toEqual([
			'autoPurgeCache',
			'autoPurgeSystemCache',
			'bypassEmitAction',
			'bypassLimits',
		]);

		const forwarded = [
			rolesService.createOne.mock.calls[0]![1],
			rolesService.updateOne.mock.calls[0]![2],
			rolesService.deleteOne.mock.calls[0]![1],
			permissionsService.createOne.mock.calls[0]![1],
			permissionsService.updateOne.mock.calls[0]![2],
			permissionsService.deleteOne.mock.calls[0]![1],
		];

		for (const call of forwarded) expect(call).toBe(options);
	});
});

describe('applyConfigPlan:result assembly and boundaries', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));
		trxRows = { directus_roles: [], directus_permissions: [] };
	});

	it('returns each kind empty result and touches neither database nor schema for an empty plan', async () => {
		const result = await applyConfigPlan(emptyPlan(), { context });

		expect(result).toEqual({
			roles: { created: [], updated: [], deleted: [] },
			permissions: { created: 0, updated: 0, deleted: 0 },
		});

		expect(vi.mocked(getDatabase)).not.toHaveBeenCalled();
		expect(vi.mocked(getSchema)).not.toHaveBeenCalled();
		expect(transactionSpy).not.toHaveBeenCalled();
	});

	it('refuses a deletion plan before touching the database or schema', async () => {
		const plan = emptyPlan();
		plan.roles.delete.push('old_role');

		await expect(applyConfigPlan(plan, { context })).rejects.toBeInstanceOf(DestructiveChangesRequiredException);

		expect(vi.mocked(getDatabase)).not.toHaveBeenCalled();
		expect(vi.mocked(getSchema)).not.toHaveBeenCalled();
		expect(transactionSpy).not.toHaveBeenCalled();
	});

	it('fills an inactive kind with its empty result and the active kind with the fresh outcome', async () => {
		rolesService.createOne.mockResolvedValue('editor');

		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

		const result = await applyConfigPlan(plan, { context });

		expect(result).toEqual({
			roles: { created: ['editor'], updated: [], deleted: [] },
			permissions: { created: 0, updated: 0, deleted: 0 },
		});
	});

	it('returns a fresh result object on each apply', async () => {
		const first = await applyConfigPlan(emptyPlan(), { context });
		first.roles.created.push('leaked');

		const second = await applyConfigPlan(emptyPlan(), { context });

		expect(second.roles.created).toEqual([]);
	});
});

describe('applyConfigPlan:missing-row deletes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));
	});

	it('deletes only the present role and reports only it, skipping a vanished row in the same operation', async () => {
		trxRows = { directus_roles: [{ id: 'r-present', key: 'present_role' }], directus_permissions: [] };
		rolesService.deleteOne.mockResolvedValue('r-present');

		const plan = emptyPlan();
		plan.roles.delete.push('present_role');
		plan.roles.delete.push('vanished_role');

		const result = await applyConfigPlan(plan, { destructive: true, context });

		expect(rolesService.deleteOne).toHaveBeenCalledTimes(1);
		expect(rolesService.deleteOne).toHaveBeenCalledWith('r-present', expect.anything());
		expect(result.roles.deleted).toEqual(['present_role']);
	});

	it('deletes only the present permission and counts only it, skipping a vanished tuple in the same operation', async () => {
		trxRows = {
			directus_roles: [{ id: 'r-editor', key: 'editor' }],
			directus_permissions: [{ id: 'p-present', role: 'r-editor', collection: 'articles', action: 'read' }],
		};

		permissionsService.deleteOne.mockResolvedValue('p-present');

		const plan = emptyPlan();
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'articles', action: 'read' });
		plan.permissions.delete.push({ roleKey: 'editor', collection: 'pages', action: 'read' });

		const result = await applyConfigPlan(plan, { destructive: true, context });

		expect(permissionsService.deleteOne).toHaveBeenCalledTimes(1);
		expect(permissionsService.deleteOne).toHaveBeenCalledWith('p-present', expect.anything());
		expect(result.permissions.deleted).toBe(1);
	});
});

describe('applyConfigPlan:registry routing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		transactionSpy.mockImplementation(async (cb: any) => cb(trxStub));
		trxRows = { directus_roles: [], directus_permissions: [] };
	});

	it('routes role apply through the registry descriptor', async () => {
		const real = CONFIG_REGISTRY.roles;

		CONFIG_REGISTRY.roles = {
			...real,
			handler: { ...real.handler, applyCreates: async () => ({ op: 'create', created: ['registry_sentinel'] }) },
		};

		try {
			const plan = emptyPlan();
			plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true });

			const result = await applyConfigPlan(plan, { context });

			expect(result).toEqual({
				roles: { created: ['registry_sentinel'], updated: [], deleted: [] },
				permissions: { created: 0, updated: 0, deleted: 0 },
			});

			expect(rolesService.createOne).not.toHaveBeenCalled();
		} finally {
			CONFIG_REGISTRY.roles = real;
		}
	});
});

describe('applyConfigPlan:admin-continuity protection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		trxRows = { directus_roles: [], directus_permissions: [] };
	});

	function protectedPlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.delete.push('administrator');

		plan.protections = [
			{
				code: 'ADMIN_CONTINUITY_REQUIRED',
				message: 'Configuration must retain at least one role with administrator access.',
				contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' } }],
			},
		];

		return plan;
	}

	it('refuses a protected plan before the database, schema, or services, even with destructive set', async () => {
		await expect(applyConfigPlan(protectedPlan(), { destructive: true, context })).rejects.toBeInstanceOf(
			ConfigProtectedRecordException
		);

		expect(getSchema).not.toHaveBeenCalled();
		expect(transactionSpy).not.toHaveBeenCalled();
		expect(rolesService.deleteOne).not.toHaveBeenCalled();
	});

	it('carries the pinned refusal extensions with inline contributors and no payload fields', async () => {
		const error = (await applyConfigPlan(protectedPlan(), { context }).catch(
			(thrown) => thrown
		)) as ConfigProtectedRecordException;

		expect(error).toBeInstanceOf(ConfigProtectedRecordException);
		expect(error.code).toBe('CONFIG_PROTECTED_RECORD');
		expect(error.status).toBe(400);

		expect(error.extensions).toEqual({
			protection: { code: 'ADMIN_CONTINUITY_REQUIRED' },
			contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' } }],
		});

		expect(error.extensions).not.toHaveProperty('code');
		expect(JSON.stringify(error.extensions)).not.toContain('impact');
		expect(JSON.stringify(error.extensions)).not.toContain('values');
	});
});

describe('applyConfigPlan:state-token recheck and scope binding', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		trxRows = { directus_roles: [], directus_permissions: [] };

		readCurrentConfigMock.mockImplementation(async () => ({
			config: { manifest: { version: 1, resources: ['permissions', 'roles'] }, roles: [], permissions: [] },
			currentRoleKeys: new Set<string>(),
			stateToken: STATE_TOKEN,
		}));
	});

	function roleWorkPlan(): ConfigPlan {
		const plan = emptyPlan();
		plan.roles.create.push({ key: 'editor', name: 'Editor', admin_access: false, app_access: true } as never);
		return plan;
	}

	it('refuses a plan whose managed resources differ from the token before any database work', async () => {
		const error = (await applyConfigPlan(roleWorkPlan(), {
			context,
			expectedStateToken: { resources: ['permissions'], digest: 'digest-current' },
		}).catch((thrown) => thrown)) as Error;

		expect(error).toBeInstanceOf(ConfigApplyScopeMismatchException);
		expect(transactionSpy).not.toHaveBeenCalled();
		expect(readCurrentConfigMock).not.toHaveBeenCalled();
		expect(rolesService.createOne).not.toHaveBeenCalled();
	});

	it('refuses a token whose duplicate resources fake the plan scope', async () => {
		const error = (await applyConfigPlan(roleWorkPlan(), {
			context,
			expectedStateToken: { resources: ['roles', 'roles'], digest: 'digest-current' },
		}).catch((thrown) => thrown)) as Error;

		expect(error).toBeInstanceOf(ConfigApplyScopeMismatchException);
		expect(transactionSpy).not.toHaveBeenCalled();
	});

	it('refuses with CONFIG_STATE_CHANGED when the in-transaction digest differs, before any handler', async () => {
		readCurrentConfigMock.mockResolvedValue({
			config: { manifest: { version: 1, resources: ['permissions', 'roles'] }, roles: [], permissions: [] },
			currentRoleKeys: new Set<string>(),
			stateToken: { resources: ['permissions', 'roles'], digest: 'digest-changed' },
		});

		const error = (await applyConfigPlan(roleWorkPlan(), { context }).catch((thrown) => thrown)) as Error;

		expect(error).toBeInstanceOf(ConfigStateChangedException);
		expect(rolesService.createOne).not.toHaveBeenCalled();
	});

	it('rechecks against the transaction-bound database and applies on a matching digest', async () => {
		await applyConfigPlan(roleWorkPlan(), { context });

		expect(readCurrentConfigMock).toHaveBeenCalledTimes(1);
		expect(readCurrentConfigMock.mock.calls[0]![0].database).toBe(trxStub);
		expect(readCurrentConfigMock.mock.calls[0]![0].resources).toEqual(['permissions', 'roles']);
		expect(rolesService.createOne).toHaveBeenCalledTimes(1);
	});

	it('maps an in-transaction read failure to CONFIG_STATE_CHANGED', async () => {
		readCurrentConfigMock.mockRejectedValue(new ConfigReadFailedException('state unavailable'));

		const error = (await applyConfigPlan(roleWorkPlan(), { context }).catch((thrown) => thrown)) as Error;

		expect(error).toBeInstanceOf(ConfigStateChangedException);
		expect(rolesService.createOne).not.toHaveBeenCalled();
	});

	it('applies an empty plan without opening a transaction or rechecking', async () => {
		await applyConfigPlan(emptyPlan(), { context });

		expect(transactionSpy).not.toHaveBeenCalled();
		expect(readCurrentConfigMock).not.toHaveBeenCalled();
	});
});
