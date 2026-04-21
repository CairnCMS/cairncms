import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { MockClient } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../logger.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import { getConfigSnapshot } from './get-config-snapshot.js';
import * as getSchema from './get-schema.js';

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
		});

		expect(config.roles[0]).not.toHaveProperty('external_identifier');
		expect(config.roles[0]).not.toHaveProperty('users');
		expect(config.roles[0]).not.toHaveProperty('id');
	});

	it('omits null-valued optional fields from role snapshots', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 'uuid-1',
				key: 'editor',
				name: 'Editor',
				icon: null,
				description: null,
				admin_access: false,
				app_access: true,
				enforce_tfa: null,
				ip_access: null,
			},
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.roles[0]).not.toHaveProperty('icon');
		expect(config.roles[0]).not.toHaveProperty('description');
		expect(config.roles[0]).not.toHaveProperty('enforce_tfa');
		expect(config.roles[0]).not.toHaveProperty('ip_access');
	});

	it('canonicalizes ip_access by sorting alphabetically', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 'uuid-1',
				key: 'editor',
				name: 'Editor',
				admin_access: false,
				app_access: true,
				ip_access: ['10.0.0.2', '192.168.1.1', '10.0.0.1'],
			},
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
			{
				id: 'admin-uuid',
				key: 'administrator',
				name: 'Administrator',
				admin_access: true,
				app_access: true,
			},
			{
				id: 'editor-uuid',
				key: 'editor',
				name: 'Editor',
				admin_access: false,
				app_access: true,
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
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

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

	it('treats malformed JSON payload fields as null and warns', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

		vi.spyOn(PermissionsService.prototype, 'readByQuery').mockResolvedValue([
			{
				id: 42,
				role: 'uuid-1',
				collection: 'articles',
				action: 'read',
				permissions: '{not valid json',
				validation: 'also not json',
				presets: '{"almost": "valid"',
				fields: null,
			},
		]);

		const config = await getConfigSnapshot({ database: db });

		expect(config.permissions[0]!.permissions[0]!.permissions).toBeNull();
		expect(config.permissions[0]!.permissions[0]!.validation).toBeNull();
		expect(config.permissions[0]!.permissions[0]!.presets).toBeNull();

		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('permissions'));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('validation'));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('presets'));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('id=42'));
	});

	it('skips synthetic system permissions', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

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
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

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

	it('parses stringified JSON payload fields', async () => {
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

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
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

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
		vi.spyOn(RolesService.prototype, 'readByQuery').mockResolvedValue([
			{ id: 'uuid-1', key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

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
			{ id: 'uuid-b', key: 'zebra', name: 'Zebra', admin_access: false, app_access: true },
			{ id: 'uuid-a', key: 'alpha', name: 'Alpha', admin_access: false, app_access: true },
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
