import { PUBLIC_ROLE_ID } from '@cairncms/constants';
import type { Accountability, Permission, SchemaOverview } from '@cairncms/types';
import { deepMap, parseFilter, parseJSON, parsePreset } from '@cairncms/utils';
import { cloneDeep } from 'lodash-es';
import hash from 'object-hash';
import { getCache, getCacheValue, getSystemCache, setCacheValue, setSystemCache } from '../cache.js';
import getDatabase from '../database/index.js';
import { appAccessMinimalPermissions } from '../database/system-data/app-access-permissions/index.js';
import env from '../env.js';
import { InvalidQueryException } from '../exceptions/invalid-query.js';
import logger from '../logger.js';
import { RolesService } from '../services/roles.js';
import { UsersService } from '../services/users.js';
import { mergePermissions } from '../utils/merge-permissions.js';
import getASTFromQuery from './get-ast-from-query.js';
import { mergePermissionsForShare } from './merge-permissions-for-share.js';

type RequiredPermissionData = {
	$CURRENT_USER: string[];
	$CURRENT_ROLE: string[];
};

const MAX_UNRESOLVED_WARNINGS = 1000;

const UNRESOLVED_WARNING_INTERVAL = 60 * 60 * 1000;

const unresolvedWarnedAt = new Map<string, number>();

let unresolvedOverflowWarnedAt = Number.NEGATIVE_INFINITY;

export async function getPermissions(accountability: Accountability, schema: SchemaOverview) {
	const database = getDatabase();
	const { cache } = getCache();

	let permissions: Permission[] = [];

	const { user, role, app, admin, share_scope } = accountability;
	const cacheKey = `permissions-${hash({ user, role, app, admin, share_scope })}`;

	if (cache && env['CACHE_PERMISSIONS'] !== false) {
		let cachedPermissions;

		try {
			cachedPermissions = await getSystemCache(cacheKey);
		} catch (err: any) {
			logger.warn(err, `[cache] Couldn't read key ${cacheKey}. ${err.message}`);
		}

		if (cachedPermissions) {
			if (!cachedPermissions['containDynamicData']) {
				return processPermissions(accountability, cachedPermissions['permissions'], {});
			}

			permissions = await withoutUnresolvedDynamicData(
				accountability,
				schema,
				parsePermissions(cachedPermissions['permissions'])
			);

			const filterContextKey = `filterContext-${hash({ user, role, permissions })}`;
			const cachedFilterContext = await getCacheValue(cache, filterContextKey);

			if (cachedFilterContext) {
				return processPermissions(accountability, permissions, cachedFilterContext);
			}

			const filterContext = await getFilterContext(schema, accountability, getRequiredPermissionData(permissions));

			if (env['CACHE_ENABLED'] !== false) {
				await setCacheValue(cache, filterContextKey, filterContext);
			}

			return processPermissions(accountability, permissions, filterContext);
		}
	}

	if (accountability.admin !== true) {
		const query = database.select('*').from('directus_permissions');

		query.where({ role: accountability.role ?? PUBLIC_ROLE_ID });

		const permissionsForRole = await query;

		permissions = parsePermissions(permissionsForRole);

		if (accountability.app === true) {
			permissions = mergePermissions(
				'or',
				permissions,
				appAccessMinimalPermissions.map((perm) => ({ ...perm, role: accountability.role }))
			);
		}

		if (accountability.share_scope) {
			permissions = mergePermissionsForShare(permissions, accountability, schema);
		}

		const containDynamicData = hasDynamicData(getRequiredPermissionData(permissions));

		const resolvablePermissions = containDynamicData
			? await withoutUnresolvedDynamicData(accountability, schema, permissions)
			: permissions;

		const filterContext = containDynamicData
			? await getFilterContext(schema, accountability, getRequiredPermissionData(resolvablePermissions))
			: {};

		if (cache && env['CACHE_PERMISSIONS'] !== false) {
			await setSystemCache(cacheKey, { permissions, containDynamicData });

			if (containDynamicData && env['CACHE_ENABLED'] !== false) {
				await setCacheValue(
					cache,
					`filterContext-${hash({ user, role, permissions: resolvablePermissions })}`,
					filterContext
				);
			}
		}

		return processPermissions(accountability, resolvablePermissions, filterContext);
	}

	return permissions;
}

function parsePermissions(permissions: any[]): Permission[] {
	return permissions.map((permissionRaw) => {
		const permission = cloneDeep(permissionRaw);

		if (permission.permissions && typeof permission.permissions === 'string') {
			permission.permissions = parseJSON(permission.permissions);
		} else if (permission.permissions === null) {
			permission.permissions = {};
		}

		if (permission.validation && typeof permission.validation === 'string') {
			permission.validation = parseJSON(permission.validation);
		} else if (permission.validation === null) {
			permission.validation = {};
		}

		if (permission.presets && typeof permission.presets === 'string') {
			permission.presets = parseJSON(permission.presets);
		} else if (permission.presets === null) {
			permission.presets = {};
		}

		if (permission.fields && typeof permission.fields === 'string') {
			permission.fields = permission.fields.split(',');
		} else if (permission.fields === null) {
			permission.fields = [];
		}

		return permission;
	});
}

function getRequiredPermissionData(permissions: Permission[]): RequiredPermissionData {
	const requiredPermissionData: RequiredPermissionData = {
		$CURRENT_USER: [],
		$CURRENT_ROLE: [],
	};

	const extractPermissionData = (val: any) => {
		if (typeof val === 'string' && val.startsWith('$CURRENT_USER.')) {
			requiredPermissionData.$CURRENT_USER.push(val.replace('$CURRENT_USER.', ''));
		}

		if (typeof val === 'string' && val.startsWith('$CURRENT_ROLE.')) {
			requiredPermissionData.$CURRENT_ROLE.push(val.replace('$CURRENT_ROLE.', ''));
		}

		return val;
	};

	for (const permission of permissions) {
		deepMap(permission.permissions, extractPermissionData);
		deepMap(permission.validation, extractPermissionData);
		deepMap(permission.presets, extractPermissionData);
	}

	return requiredPermissionData;
}

function hasDynamicData(requiredPermissionData: RequiredPermissionData) {
	return requiredPermissionData.$CURRENT_USER.length > 0 || requiredPermissionData.$CURRENT_ROLE.length > 0;
}

async function withoutUnresolvedDynamicData(
	accountability: Accountability,
	schema: SchemaOverview,
	permissions: Permission[]
): Promise<Permission[]> {
	const resolved = new Map<string, boolean>();

	const pathResolves = async (collection: string, path: string) => {
		const key = `${collection}:${path}`;

		if (!resolved.has(key)) {
			resolved.set(key, await dynamicPathResolves(schema, collection, path));
		}

		return resolved.get(key)!;
	};

	const resolvable: Permission[] = [];

	for (const permission of permissions) {
		const { $CURRENT_USER, $CURRENT_ROLE } = getRequiredPermissionData([permission]);

		let unresolved = false;

		for (const path of $CURRENT_USER) {
			if (!(await pathResolves('directus_users', path))) unresolved = true;
		}

		for (const path of $CURRENT_ROLE) {
			if (!(await pathResolves('directus_roles', path))) unresolved = true;
		}

		if (unresolved) {
			warnUnresolvedPermission(accountability, permission);
			continue;
		}

		resolvable.push(permission);
	}

	return resolvable;
}

async function dynamicPathResolves(schema: SchemaOverview, collection: string, path: string) {
	try {
		await getASTFromQuery(collection, { fields: [path] }, schema, { strict: true });
		return true;
	} catch (error) {
		if (error instanceof InvalidQueryException) return false;
		throw error;
	}
}

function warnUnresolvedPermission(accountability: Accountability, permission: Permission) {
	const role = accountability.role ?? PUBLIC_ROLE_ID;
	const key = `${role}:${permission.collection}:${permission.action}`;
	const now = Date.now();
	const warnedAt = unresolvedWarnedAt.get(key);

	if (warnedAt !== undefined && now - warnedAt < UNRESOLVED_WARNING_INTERVAL) return;

	if (warnedAt === undefined && unresolvedWarnedAt.size >= MAX_UNRESOLVED_WARNINGS) {
		for (const [entry, at] of unresolvedWarnedAt) {
			if (now - at >= UNRESOLVED_WARNING_INTERVAL) unresolvedWarnedAt.delete(entry);
		}
	}

	if (warnedAt === undefined && unresolvedWarnedAt.size >= MAX_UNRESOLVED_WARNINGS) {
		if (now - unresolvedOverflowWarnedAt >= UNRESOLVED_WARNING_INTERVAL) {
			unresolvedOverflowWarnedAt = now;

			logger.warn(
				`More than ${MAX_UNRESOLVED_WARNINGS} permissions use dynamic variables whose fields no longer exist, so further warnings are suppressed for an hour`
			);
		}

		return;
	}

	unresolvedWarnedAt.set(key, now);

	logger.warn(
		`The ${permission.action} permission on "${permission.collection}" for role "${role}" uses a dynamic variable whose field no longer exists and will deny access until it is repaired`
	);
}

async function getFilterContext(
	schema: SchemaOverview,
	accountability: Accountability,
	requiredPermissionData: RequiredPermissionData
) {
	const usersService = new UsersService({ schema });
	const rolesService = new RolesService({ schema });

	const filterContext: Record<string, any> = {};

	if (accountability.user && requiredPermissionData.$CURRENT_USER.length > 0) {
		filterContext['$CURRENT_USER'] = await usersService.readOne(accountability.user, {
			fields: requiredPermissionData.$CURRENT_USER,
		});
	}

	if (accountability.role && requiredPermissionData.$CURRENT_ROLE.length > 0) {
		filterContext['$CURRENT_ROLE'] = await rolesService.readOne(accountability.role, {
			fields: requiredPermissionData.$CURRENT_ROLE,
		});
	}

	return filterContext;
}

function processPermissions(
	accountability: Accountability,
	permissions: Permission[],
	filterContext: Record<string, any>
) {
	return permissions.map((permission) => {
		permission.permissions = parseFilter(permission.permissions, accountability!, filterContext);
		permission.validation = parseFilter(permission.validation, accountability!, filterContext);
		permission.presets = parsePreset(permission.presets, accountability!, filterContext);

		return permission;
	});
}
