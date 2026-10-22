import type { Accountability, Permission, SchemaOverview } from '@cairncms/types';
import { cloneDeep } from 'lodash-es';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { permissionRows, systemStore, contextStore, readUser, warn } = vi.hoisted(() => ({
	permissionRows: [] as Record<string, unknown>[],
	systemStore: new Map<string, unknown>(),
	contextStore: new Map<string, unknown>(),
	readUser: vi.fn(),
	warn: vi.fn(),
}));

vi.mock('../database/index.js', () => {
	const query = {
		where: () => query,
		then: (resolve: (rows: unknown[]) => unknown) => resolve(cloneDeep(permissionRows)),
	};

	return { default: () => ({ select: () => ({ from: () => query }) }) };
});

vi.mock('../cache.js', () => ({
	getCache: () => ({ cache: {} }),
	getSystemCache: async (key: string) => cloneDeep(systemStore.get(key)),
	setSystemCache: async (key: string, value: unknown) => void systemStore.set(key, cloneDeep(value)),
	getCacheValue: async (_cache: unknown, key: string) => cloneDeep(contextStore.get(key)),
	setCacheValue: async (_cache: unknown, key: string, value: unknown) => void contextStore.set(key, cloneDeep(value)),
}));

vi.mock('../env.js', () => ({ default: { CACHE_PERMISSIONS: true, CACHE_ENABLED: true } }));
vi.mock('../logger.js', () => ({ default: { warn } }));

vi.mock('../services/users.js', () => ({
	UsersService: class {
		readOne = readUser;
	},
}));

vi.mock('../services/roles.js', () => ({
	RolesService: class {
		readOne = vi.fn();
	},
}));

function makeField(name: string): any {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type: 'string',
		dbType: 'varchar',
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
	};
}

function makeCollection(collection: string, fields: string[]): any {
	return {
		collection,
		primary: 'id',
		singleton: false,
		sortField: null,
		note: null,
		accountability: null,
		fields: Object.fromEntries(['id', ...fields].map((name) => [name, makeField(name)])),
	};
}

function makeSchema({ withOrg = true, withOrgs = true } = {}): SchemaOverview {
	const collections: Record<string, unknown> = {
		directus_users: makeCollection('directus_users', withOrg ? ['email', 'org'] : ['email']),
		directus_roles: makeCollection('directus_roles', ['name']),
	};

	if (withOrgs) collections['orgs'] = makeCollection('orgs', ['name', 'blocked_tenant']);

	return {
		collections,
		relations: withOrg
			? [{ collection: 'directus_users', field: 'org', related_collection: 'orgs', schema: null, meta: null }]
			: [],
	} as unknown as SchemaOverview;
}

function makeRow(collection: string, permissions: Record<string, unknown>, action = 'read') {
	return {
		id: permissionRows.length + 1,
		role: 'role-uuid',
		collection,
		action,
		permissions: JSON.stringify(permissions),
		validation: null,
		presets: null,
		fields: '*',
	};
}

const accountability: Accountability = {
	user: 'user-uuid',
	role: 'role-uuid',
	admin: false,
	app: false,
	ip: '127.0.0.1',
};

const blockedTenant = { tenant: { _neq: '$CURRENT_USER.org.blocked_tenant' } };
const otherEmail = { name: { _neq: '$CURRENT_USER.email' } };

function findPermission(permissions: Permission[], collection: string, action = 'read') {
	return permissions.find((permission) => permission.collection === collection && permission.action === action);
}

async function loadGetPermissions() {
	return (await import('./get-permissions.js')).getPermissions;
}

beforeEach(() => {
	vi.resetModules();
	permissionRows.length = 0;
	systemStore.clear();
	contextStore.clear();
	warn.mockClear();

	readUser.mockReset().mockImplementation(async (_id: string, { fields }: { fields: string[] }) => {
		const user: Record<string, unknown> = {};
		if (fields.includes('email')) user['email'] = 'user@example.com';
		if (fields.includes('org.blocked_tenant')) user['org'] = { blocked_tenant: 'B' };
		return user;
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('getPermissions with a dynamic variable path that no longer exists', () => {
	it('leaves out only the permission whose path does not resolve', async () => {
		permissionRows.push(makeRow('articles', blockedTenant), makeRow('orgs', otherEmail));
		const getPermissions = await loadGetPermissions();

		const permissions = await getPermissions(accountability, makeSchema({ withOrg: false }));

		expect(findPermission(permissions, 'articles')).toBeUndefined();
		expect(findPermission(permissions, 'orgs')?.permissions).toEqual({ name: { _neq: 'user@example.com' } });
		expect(readUser).toHaveBeenCalledWith('user-uuid', { fields: ['email'] });
	});

	it('leaves out a permission whose relation target is missing from the schema', async () => {
		permissionRows.push(makeRow('articles', blockedTenant), makeRow('orgs', otherEmail));
		const getPermissions = await loadGetPermissions();

		const permissions = await getPermissions(accountability, makeSchema({ withOrgs: false }));

		expect(findPermission(permissions, 'articles')).toBeUndefined();
		expect(findPermission(permissions, 'orgs')).toBeDefined();
	});

	it('denies a permission merged with the app access defaults instead of falling back to them', async () => {
		permissionRows.push(makeRow('directus_users', { email: { _neq: '$CURRENT_USER.org.blocked_tenant' } }));
		const getPermissions = await loadGetPermissions();

		const permissions = await getPermissions({ ...accountability, app: true }, makeSchema({ withOrg: false }));

		expect(findPermission(permissions, 'directus_users')).toBeUndefined();
		expect(findPermission(permissions, 'directus_roles')).toBeDefined();
	});

	it('resolves the restored path from a fresh context when the cache was filled while it was broken', async () => {
		permissionRows.push(makeRow('articles', blockedTenant), makeRow('orgs', otherEmail));
		const getPermissions = await loadGetPermissions();

		const broken = await getPermissions(accountability, makeSchema({ withOrg: false }));
		expect(findPermission(broken, 'articles')).toBeUndefined();

		const restored = await getPermissions(accountability, makeSchema());
		expect(findPermission(restored, 'articles')?.permissions).toEqual({ tenant: { _neq: 'B' } });
		expect(readUser).toHaveBeenLastCalledWith('user-uuid', { fields: ['org.blocked_tenant', 'email'] });
	});

	it('reuses the cached context for the same passing permissions', async () => {
		permissionRows.push(makeRow('articles', blockedTenant), makeRow('orgs', otherEmail));
		const getPermissions = await loadGetPermissions();

		await getPermissions(accountability, makeSchema());
		await getPermissions(accountability, makeSchema({ withOrg: false }));
		const readsBeforeRestore = readUser.mock.calls.length;

		const restored = await getPermissions(accountability, makeSchema());

		expect(findPermission(restored, 'articles')?.permissions).toEqual({ tenant: { _neq: 'B' } });
		expect(readUser.mock.calls.length).toBe(readsBeforeRestore);
	});
});

describe('warnings for permissions whose dynamic variable path no longer exists', () => {
	it('warns once per permission within an hour and again after it', async () => {
		vi.useFakeTimers();
		permissionRows.push(makeRow('articles', blockedTenant));
		const getPermissions = await loadGetPermissions();

		await getPermissions(accountability, makeSchema({ withOrg: false }));
		await getPermissions(accountability, makeSchema({ withOrg: false }));
		expect(warn).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60 * 60 * 1000);
		await getPermissions(accountability, makeSchema({ withOrg: false }));
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('names the role, collection, and action without the rule or its values', async () => {
		permissionRows.push(makeRow('articles', blockedTenant));
		const getPermissions = await loadGetPermissions();

		await getPermissions(accountability, makeSchema({ withOrg: false }));

		const message = warn.mock.calls[0]![0] as string;

		expect(message).toBe(
			'The read permission on "articles" for role "role-uuid" uses a dynamic variable whose field no longer exists and will deny access until it is repaired'
		);

		expect(message).not.toContain('blocked_tenant');
		expect(message).not.toContain('$CURRENT_USER');
	});

	it('caps individual warnings and summarizes the rest', async () => {
		for (let index = 0; index <= 1000; index++) {
			permissionRows.push(makeRow(`collection_${index}`, blockedTenant));
		}

		const getPermissions = await loadGetPermissions();

		await getPermissions(accountability, makeSchema({ withOrg: false }));
		expect(warn).toHaveBeenCalledTimes(1001);
		expect(warn.mock.calls[1000]![0]).toContain('More than 1000 permissions');

		await getPermissions(accountability, makeSchema({ withOrg: false }));
		expect(warn).toHaveBeenCalledTimes(1001);
	});
});
