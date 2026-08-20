import type { ConfigPermission, ConfigRole, PermissionValues, RoleValues } from '../types/config.js';

const DEFAULT_ROLE_ICON = 'supervised_user_circle';

function sortedOrNull(values: string[] | null | undefined): string[] | null {
	if (values == null) return null;
	return [...values].sort();
}

export function canonicalizeRole(role: ConfigRole): RoleValues {
	return {
		name: role.name,
		icon: role.icon ?? DEFAULT_ROLE_ICON,
		description: role.description ?? null,
		admin_access: role.admin_access,
		app_access: role.app_access,
		enforce_tfa: role.enforce_tfa ?? false,
		ip_access: sortedOrNull(role.ip_access),
	};
}

export function canonicalizePermission(permission: ConfigPermission): PermissionValues {
	return {
		permissions: permission.permissions,
		validation: permission.validation,
		presets: permission.presets,
		fields: sortedOrNull(permission.fields),
	};
}
