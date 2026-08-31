import { PUBLIC_ROLE_ID } from '@cairncms/constants';
import type { Filter, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { MockClient } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import logger from '../logger.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import { rolesDescriptor } from './config/handlers/roles.js';
import { CONFIG_REGISTRY } from './config/registry.js';
import { getConfigSnapshot, readCurrentConfig } from './get-config-snapshot.js';
import * as getSchema from './get-schema.js';
import { validateDesiredConfig } from './validate-desired-config.js';

function roleRow(overrides: Record<string, any> = {}): Record<string, any> {
	return {
		id: 'uuid-1',
		key: 'editor',
		name: 'Editor',
		icon: 'supervised_user_circle',
		description: null,
		admin_access: false,
		app_access: true,
		enforce_tfa: false,
		ip_access: null,
		...overrides,
	};
}

function mockRole(overrides: Record<string, any> = {}): void {
	vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow(overrides)]);
}

function mockPermission(overrides: Record<string, any> = {}): void {
	vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
		{
			id: 42,
			role: 'uuid-1',
			collection: 'articles',
			action: 'read',
			permissions: null,
			validation: null,
			presets: null,
			fields: null,
			...overrides,
		},
	]);
}

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const testSchema = {} as SchemaOverview;

describe('getConfigSnapshot', () => {
	let db: MockedFunction<Knex>;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		vi.spyOn(getSchema, 'getSchema').mockResolvedValue(testSchema);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns manifest with version 1 and declared resources', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([]);
		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.manifest).toEqual({ version: 1, resources: ['roles', 'permissions'] });
	});

	it('builds ConfigRole entries with v1 allowlist only', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 'uuid-1',
				key: 'editor',
				name: 'Editor',
				icon: 'edit',
				description: 'Content editor',
				admin_access: false,
				app_access: true,
				enforce_tfa: false,
				ip_access: null,
				external_identifier: 'legacy-sso-id',
				users: ['user-1', 'user-2'],
			},
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.roles).toHaveLength(1);

		expect(config.roles[0]).toEqual({
			key: 'editor',
			name: 'Editor',
			icon: 'edit',
			description: 'Content editor',
			admin_access: false,
			app_access: true,
			enforce_tfa: false,
			ip_access: null,
		});

		expect(config.roles[0]).not.toHaveProperty('external_identifier');
		expect(config.roles[0]).not.toHaveProperty('users');
		expect(config.roles[0]).not.toHaveProperty('id');
	});

	it('records explicit null for nullable columns so the snapshot fully describes the row', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 'uuid-1',
				key: 'editor',
				name: 'Editor',
				icon: 'badge',
				description: null,
				admin_access: false,
				app_access: true,
				enforce_tfa: false,
				ip_access: null,
			},
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.roles[0]!.description).toBeNull();
		expect(config.roles[0]!.ip_access).toBeNull();
	});

	it('aborts when the nullable description column is absent, rather than fabricating null', async () => {
		const row = roleRow();
		delete row['description'];

		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([row]);
		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const error = await getConfigSnapshot({ database: db }).catch((err) => err);

		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect(error.message).toContain('"description" was absent from the row');
	});

	it('aborts when the nullable ip_access column is absent, rather than fabricating null', async () => {
		const row = roleRow();
		delete row['ip_access'];

		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([row]);
		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const error = await getConfigSnapshot({ database: db }).catch((err) => err);

		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect(error.message).toContain('"ip_access" was absent from the row');
	});

	it('canonicalizes ip_access by sorting alphabetically', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			roleRow({ ip_access: ['10.0.0.2', '192.168.1.1', '10.0.0.1'] }),
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.roles[0]!.ip_access).toEqual(['10.0.0.1', '10.0.0.2', '192.168.1.1']);
	});

	it('excludes sentinel but includes normal roles and groups public permissions correctly', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: '00000000-0000-0000-0000-000000000000',
				key: 'public',
				name: '$t:public_label',
				admin_access: false,
				app_access: false,
			},
			roleRow({ id: 'admin-uuid', key: 'administrator', name: 'Administrator', admin_access: true }),
			roleRow({ id: 'editor-uuid', key: 'editor', name: 'Editor' }),
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: '00000000-0000-0000-0000-000000000000',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
			{
				id: 2,
				role: 'editor-uuid',
				collection: 'articles',
				action: 'update',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		// Sentinel excluded, other two roles present
		expect(config.roles.map((r) => r.key).sort()).toEqual(['administrator', 'editor']);

		// Permissions grouped by their role's key (public for sentinel, editor for editor-uuid)
		expect(config.permissions.map((p) => p.role).sort()).toEqual(['editor', 'public']);

		const publicSet = config.permissions.find((p) => p.role === 'public');
		expect(publicSet!.permissions).toHaveLength(1);
		expect(publicSet!.permissions[0]!.collection).toBe('articles');

		const editorSet = config.permissions.find((p) => p.role === 'editor');
		expect(editorSet!.permissions).toHaveLength(1);
		expect(editorSet!.permissions[0]!.action).toBe('update');
	});

	it('groups permissions on the sentinel role under the "public" key', async () => {
		// The sentinel row lives in directus_roles; snapshot excludes it from
		// config.roles but still uses its UUID→key mapping to resolve public permissions.
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: '00000000-0000-0000-0000-000000000000',
				key: 'public',
				name: '$t:public_label',
				admin_access: false,
				app_access: false,
			},
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: '00000000-0000-0000-0000-000000000000',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.roles).toEqual([]);
		expect(config.permissions).toHaveLength(1);
		expect(config.permissions[0]!.role).toBe('public');
		expect(config.permissions[0]!.permissions).toHaveLength(1);
	});

	it('skips orphaned permissions referencing non-existent roles and warns', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
			{
				id: 2,
				role: 'ghost-uuid',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.permissions).toHaveLength(1);
		expect(config.permissions[0]!.role).toBe('editor');

		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-existent role'));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('orphaned permission'));
	});

	it('aborts on a malformed JSON payload field rather than exporting it as no policy', async () => {
		mockRole();
		mockPermission({ permissions: '{not valid json' });

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		await expect(getConfigSnapshot({ database: db })).rejects.toThrow('id=42');
		await expect(getConfigSnapshot({ database: db })).rejects.toThrow('permissions');
	});

	it('aborts on stored policy that parses to a scalar or an array', async () => {
		for (const value of ['"just a string"', '42', 'true', '[{"_eq":1}]']) {
			mockRole();
			mockPermission({ permissions: value });

			await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		}
	});

	it('aborts on a bare array in a policy column', async () => {
		mockRole();
		mockPermission({ validation: [{ _eq: 1 }] });

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
	});

	it('aborts on numeric and boolean policy columns', async () => {
		for (const value of [42, true]) {
			mockRole();
			mockPermission({ presets: value });

			await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		}
	});

	it('aborts when a policy column is absent from the row, which is an incomplete read', async () => {
		mockRole();
		mockPermission({ permissions: undefined });

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		await expect(getConfigSnapshot({ database: db })).rejects.toThrow('incomplete');
	});

	it('aborts on a non-string element in a stored field list', async () => {
		mockRole();
		mockPermission({ fields: ['title', 7] });

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
	});

	it('aborts on a stored filter nested past the supported depth', async () => {
		let nested: Filter = { id: { _eq: 'probe' } };
		for (let level = 0; level < 150; level++) nested = { _and: [nested] };

		mockRole();
		mockPermission({ permissions: nested });

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
	});

	it('accepts every action the permission contract defines', async () => {
		for (const action of ['create', 'read', 'update', 'delete', 'comment', 'explain', 'share']) {
			mockRole();
			mockPermission({ action });

			const config = await getConfigSnapshot({ database: db });

			expect(config.permissions[0]!.permissions[0]!.action).toBe(action);
		}
	});

	it('aborts on a role key that is empty or fails the key grammar', async () => {
		for (const key of ['', 'Editor', '2fa_admin', '_tmp']) {
			vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
				{ id: 'uuid-1', key, name: 'Editor', admin_access: false, app_access: true },
			]);

			vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

			await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		}
	});

	it('aborts on a string admin_access, which would count as an administrator by truthiness', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: 'false', app_access: true },
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		await expect(getConfigSnapshot({ database: db })).rejects.toThrow('admin_access');
	});

	it('aborts on a non-boolean app_access and a malformed ip_access element', async () => {
		for (const role of [
			{ admin_access: false, app_access: 1 },
			{ admin_access: false, app_access: true, ip_access: ['10.0.0.1', 7] },
		]) {
			vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
				{ id: 'uuid-1', key: 'editor', name: 'Editor', ...role },
			]);

			vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

			await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		}
	});

	it('aborts on an unsupported permission action', async () => {
		mockRole();
		mockPermission({ action: 'drop' });

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow(ConfigReadFailedException);
		await expect(getConfigSnapshot({ database: db })).rejects.toThrow('supported action');
	});

	it('reads current state unfiltered, so no query filter, read filter, or read action can shape it', async () => {
		const roles = vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		const perms = vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		await getConfigSnapshot({ database: db });

		expect(roles).toHaveBeenCalledWith(expect.anything(), { emitEvents: false });
		expect(perms).toHaveBeenCalledWith(expect.anything(), { emitEvents: false });
	});

	it('still exports a real NULL policy column as null', async () => {
		mockRole();
		mockPermission({ permissions: null, validation: null, presets: null, fields: null });

		const config = await getConfigSnapshot({ database: db });
		const permission = config.permissions[0]!.permissions[0]!;

		expect(permission.permissions).toBeNull();
		expect(permission.validation).toBeNull();
		expect(permission.presets).toBeNull();
		expect(permission.fields).toBeNull();
	});

	it('refuses to export a display column it cannot represent, naming the role', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow({ name: 42 })]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const error = await getConfigSnapshot({ database: db }).catch((err) => err);

		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect(error.message).toContain('role key=editor');
		expect(error.message).toContain('"name" must be a string');
	});

	it('refuses to export a permission set it cannot represent, naming the role', async () => {
		mockRole();
		mockPermission({ collection: 'x'.repeat(65) });

		const error = await getConfigSnapshot({ database: db }).catch((err) => err);

		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect(error.message).toContain('permissions for role key=editor');
		expect(error.message).toContain('collection');
		expect(error.message).toContain('less than or equal to 64');
	});

	it('skips synthetic system permissions', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				system: true,
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.permissions).toEqual([]);
	});

	it('throws on duplicate (role, collection, action) tuples', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
			{
				id: 2,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: { id: { _eq: 1 } },
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		await expect(getConfigSnapshot({ database: db })).rejects.toThrow('Duplicate permission');
	});

	it('sanitizes control characters in both dynamic values of the orphan warning', async () => {
		mockRole();
		const idControl = String.fromCharCode(1);
		const roleControl = String.fromCharCode(2);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: `7${idControl}`,
				role: `ghost${roleControl}`,
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		await getConfigSnapshot({ database: db });

		expect(logger.warn).toHaveBeenCalledWith(
			'Permission id=7? references non-existent role ghost?, skipped in snapshot.'
		);
	});

	it('sanitizes control characters in the duplicate permission error', async () => {
		mockRole();
		const control = String.fromCharCode(1);

		const duplicate = {
			role: 'uuid-1',
			collection: `arti${control}cles`,
			action: 'read',
			permissions: null,
			validation: null,
			presets: null,
			fields: null,
		};

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 1, ...duplicate },
			{ id: 2, ...duplicate },
		]);

		const error = await getConfigSnapshot({ database: db }).catch((err) => err);

		expect(error.message).toContain('Duplicate permission found');
		expect(error.message).not.toContain(control);
	});

	it('parses stringified JSON payload fields', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: '{"status":{"_eq":"published"}}',
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.permissions[0]!.permissions[0]!.permissions).toEqual({ status: { _eq: 'published' } });
	});

	it('parses CSV fields and sorts them alphabetically', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: 'title,author,body',
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.permissions[0]!.permissions[0]!.fields).toEqual(['author', 'body', 'title']);
	});

	it('returns null for empty CSV fields', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: '',
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.permissions[0]!.permissions[0]!.fields).toBeNull();
	});

	it('sorts output deterministically (roles by key, permissions by collection+action)', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			roleRow({ id: 'uuid-b', key: 'zebra', name: 'Zebra' }),
			roleRow({ id: 'uuid-a', key: 'alpha', name: 'Alpha' }),
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-a',
				collection: 'posts',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
			{
				id: 2,
				role: 'uuid-a',
				collection: 'articles',
				action: 'update',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
			{
				id: 3,
				role: 'uuid-a',
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.roles.map((r) => r.key)).toEqual(['alpha', 'zebra']);

		expect(config.permissions[0]!.permissions.map((p) => `${p.collection}:${p.action}`)).toEqual([
			'articles:read',
			'articles:update',
			'posts:read',
		]);
	});
});

describe('readCurrentConfig', () => {
	let db: MockedFunction<Knex>;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		vi.spyOn(getSchema, 'getSchema').mockResolvedValue(testSchema);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('groups permissions under a portable role key without exporting the role', async () => {
		const roles = vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow()]);

		mockPermission();

		const { config, currentRoleKeys } = await readCurrentConfig({ database: db, resources: ['permissions'] });

		expect(roles).toHaveBeenCalledWith({ limit: -1, fields: ['id', 'key'] }, { emitEvents: false });
		expect(config.roles).toEqual([]);
		expect(config.permissions[0]!.role).toBe('editor');
		expect(currentRoleKeys.has('editor')).toBe(true);
	});

	it('returns a stable state token digest for an unchanged managed read closure', async () => {
		mockRole();
		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const first = await readCurrentConfig({ database: db, resources: ['roles'] });
		const second = await readCurrentConfig({ database: db, resources: ['roles'] });

		expect(first.stateToken.resources).toEqual(['roles']);
		expect(second.stateToken.digest).toBe(first.stateToken.digest);
	});

	it('changes the state token digest when a managed role value changes', async () => {
		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);
		const roles = vi.spyOn(RolesService.prototype, 'readByQuery');

		roles.mockResolvedValueOnce([roleRow({ admin_access: false })]);
		const before = await readCurrentConfig({ database: db, resources: ['roles'] });

		roles.mockResolvedValueOnce([roleRow({ admin_access: true })]);
		const after = await readCurrentConfig({ database: db, resources: ['roles'] });

		expect(after.stateToken.digest).not.toBe(before.stateToken.digest);
	});

	it('changes the state token digest when a dependency role identity is removed even though managed permissions are unchanged', async () => {
		const permission = {
			id: 42,
			role: 'uuid-view',
			collection: 'articles',
			action: 'read',
			permissions: null,
			validation: null,
			presets: null,
			fields: null,
		};

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([permission]);
		const roles = vi.spyOn(RolesService.prototype, 'readByQuery');

		roles.mockResolvedValueOnce([
			{ id: 'uuid-1', key: 'editor' },
			{ id: 'uuid-view', key: 'viewer' },
		]);

		const withEditor = await readCurrentConfig({ database: db, resources: ['permissions'] });

		roles.mockResolvedValueOnce([{ id: 'uuid-view', key: 'viewer' }]);

		const withoutEditor = await readCurrentConfig({ database: db, resources: ['permissions'] });

		expect(withEditor.config.permissions[0]!.role).toBe('viewer');
		expect(withoutEditor.config.permissions).toEqual(withEditor.config.permissions);
		expect(withoutEditor.stateToken.digest).not.toBe(withEditor.stateToken.digest);
	});

	it('changes the state token digest when a stored permission policy changes', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([{ id: 'uuid-1', key: 'editor' } as never]);
		const perms = vi.spyOn(PermissionsService.prototype, 'readByQuery');

		const row = (permissions: Record<string, unknown>) => ({
			id: 42,
			role: 'uuid-1',
			collection: 'articles',
			action: 'read',
			permissions,
			validation: { status: { _eq: 'published' } },
			presets: { status: 'published' },
			fields: 'title,body',
		});

		perms.mockResolvedValueOnce([row({ status: { _eq: 'published' } })]);
		const before = await readCurrentConfig({ database: db, resources: ['permissions'] });

		perms.mockResolvedValueOnce([row({ status: { _eq: 'draft' } })]);
		const after = await readCurrentConfig({ database: db, resources: ['permissions'] });

		expect(after.stateToken.digest).not.toBe(before.stateToken.digest);
	});

	it('reads an unrelated role that cannot be exported, because only its identity is needed', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			roleRow(),
			{ id: 'uuid-2', key: 'broken', name: 'Broken', admin_access: 'false', app_access: true },
		]);

		mockPermission();

		const { config } = await readCurrentConfig({ database: db, resources: ['permissions'] });

		expect(config.permissions[0]!.role).toBe('editor');
	});

	it('still refuses a malformed access column when roles are managed', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-2', key: 'broken', name: 'Broken', admin_access: 'false', app_access: true },
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		await expect(readCurrentConfig({ database: db, resources: ['roles'] })).rejects.toMatchObject({
			code: 'CONFIG_READ_FAILED',
		});
	});

	it('skips the permission query when only roles are managed', async () => {
		mockRole();
		const perms = vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const { config } = await readCurrentConfig({ database: db, resources: ['roles'] });

		expect(perms).not.toHaveBeenCalled();
		expect(config.permissions).toEqual([]);
		expect(config.roles).toHaveLength(1);
	});

	it('queries neither service when nothing is managed', async () => {
		const roles = vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([]);
		const perms = vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const { config, currentRoleKeys } = await readCurrentConfig({ database: db, resources: [] });

		expect(roles).not.toHaveBeenCalled();
		expect(perms).not.toHaveBeenCalled();
		expect(getSchema.getSchema).not.toHaveBeenCalled();
		expect(config).toEqual({ manifest: { version: 1, resources: [] }, roles: [], permissions: [] });
		expect(currentRoleKeys.size).toBe(0);
	});

	it('fails closed when the roles read publishes no dependency state', async () => {
		vi.spyOn(rolesDescriptor.handler, 'readCurrent').mockResolvedValue({
			records: [],
			documentIdentities: [],
			dependencyState: undefined,
		} as never);

		const error = await readCurrentConfig({ database: db, resources: ['roles'] }).catch((err) => err);

		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect(error.message).toContain('Configuration state could not be assembled');
		expect(error.message).not.toContain('published');
	});

	it('routes role reads through the registry descriptor', async () => {
		const real = CONFIG_REGISTRY.roles;
		const rolesRead = vi.spyOn(RolesService.prototype, 'readByQuery');

		CONFIG_REGISTRY.roles = {
			...real,
			handler: {
				...real.handler,
				readCurrent: async () => ({
					records: [{ key: 'registry_sentinel', name: 'Sentinel', admin_access: false, app_access: true }],
					documentIdentities: [{ key: 'registry_sentinel' }],
					dependencyState: { currentRoleKeys: new Set(['registry_sentinel']), roleKeyById: new Map() },
				}),
			},
		};

		try {
			const { config } = await readCurrentConfig({ database: db, resources: ['roles'] });

			expect(config.roles).toEqual([
				{ key: 'registry_sentinel', name: 'Sentinel', admin_access: false, app_access: true },
			]);

			expect(rolesRead).not.toHaveBeenCalled();
		} finally {
			CONFIG_REGISTRY.roles = real;
		}
	});

	it('produces a document its own validator accepts, including permissions on the public role', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: PUBLIC_ROLE_ID, key: 'public', name: 'Public', admin_access: false, app_access: false },
			{
				id: 'uuid-1',
				key: 'editor',
				name: 'Editor',
				icon: 'edit',
				description: null,
				admin_access: false,
				app_access: true,
				enforce_tfa: false,
				ip_access: '10.0.0.1,10.0.0.2',
			},
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 1,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: { status: { _eq: 'published' } },
				validation: null,
				presets: null,
				fields: 'title,body',
			},
			{
				id: 2,
				role: PUBLIC_ROLE_ID,
				collection: 'articles',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: null,
			},
		]);

		const { config, currentRoleKeys } = await readCurrentConfig({
			database: db,
			resources: ['roles', 'permissions'],
		});

		expect(config.permissions.map((set) => set.role)).toEqual(['editor', 'public']);
		expect(validateDesiredConfig(config, { label: 'snapshot', currentRoleKeys })).toEqual([]);
	});
});

describe('central subject sanitization', () => {
	let db: MockedFunction<Knex>;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		vi.spyOn(getSchema, 'getSchema').mockResolvedValue(testSchema);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sanitizes the emitted-document subject value through readCurrentConfig', async () => {
		vi.spyOn(rolesDescriptor, 'emittedDocumentSubject').mockReturnValue({ label: 'role key', value: 'bad\nvalue' });
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([roleRow({ name: 42 })]);
		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const error = await readCurrentConfig({ database: db, resources: ['roles'] }).catch((err) => err);

		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect(error.message).toContain('role key=bad?value');
		expect(error.message).not.toContain('\n');
	});
});
