import { isEqual } from 'lodash-es';
import type {
	ConfigFailure,
	ConfigKind,
	ConfigPlan,
	ConfigPermission,
	ConfigRole,
	CairnConfig,
	PermissionFieldChanges,
	RoleFieldChanges,
} from '../types/config.js';
import { canonicalizePermission, canonicalizeRole } from './canonicalize-config-record.js';

function permKey(roleKey: string, perm: ConfigPermission): string {
	return `${roleKey}::${perm.collection}::${perm.action}`;
}

function roleChanges(current: ConfigRole, desired: ConfigRole): RoleFieldChanges {
	const before = canonicalizeRole(current);
	const after = canonicalizeRole(desired);
	const changes: RoleFieldChanges = {};

	if (Object.hasOwn(desired, 'name') && !isEqual(before.name, after.name)) {
		changes.name = { before: before.name, after: after.name };
	}

	if (Object.hasOwn(desired, 'icon') && !isEqual(before.icon, after.icon)) {
		changes.icon = { before: before.icon, after: after.icon };
	}

	if (Object.hasOwn(desired, 'description') && !isEqual(before.description, after.description)) {
		changes.description = { before: before.description, after: after.description };
	}

	if (Object.hasOwn(desired, 'admin_access') && !isEqual(before.admin_access, after.admin_access)) {
		changes.admin_access = { before: before.admin_access, after: after.admin_access };
	}

	if (Object.hasOwn(desired, 'app_access') && !isEqual(before.app_access, after.app_access)) {
		changes.app_access = { before: before.app_access, after: after.app_access };
	}

	if (Object.hasOwn(desired, 'enforce_tfa') && !isEqual(before.enforce_tfa, after.enforce_tfa)) {
		changes.enforce_tfa = { before: before.enforce_tfa, after: after.enforce_tfa };
	}

	if (Object.hasOwn(desired, 'ip_access') && !isEqual(before.ip_access, after.ip_access)) {
		changes.ip_access = { before: before.ip_access, after: after.ip_access };
	}

	return changes;
}

function permChanges(current: ConfigPermission, desired: ConfigPermission): PermissionFieldChanges {
	const before = canonicalizePermission(current);
	const after = canonicalizePermission(desired);
	const changes: PermissionFieldChanges = {};

	if (!isEqual(before.permissions, after.permissions)) {
		changes.permissions = { before: before.permissions, after: after.permissions };
	}

	if (!isEqual(before.validation, after.validation)) {
		changes.validation = { before: before.validation, after: after.validation };
	}

	if (!isEqual(before.presets, after.presets)) {
		changes.presets = { before: before.presets, after: after.presets };
	}

	if (!isEqual(before.fields, after.fields)) {
		changes.fields = { before: before.fields, after: after.fields };
	}

	return changes;
}

function roleDiffFromChanges(changes: RoleFieldChanges): Partial<ConfigRole> {
	const diff: Partial<ConfigRole> = {};

	if (changes.name) diff.name = changes.name.after;
	if (changes.icon) diff.icon = changes.icon.after;
	if (changes.description) diff.description = changes.description.after;
	if (changes.admin_access) diff.admin_access = changes.admin_access.after;
	if (changes.app_access) diff.app_access = changes.app_access.after;
	if (changes.enforce_tfa) diff.enforce_tfa = changes.enforce_tfa.after;
	if (changes.ip_access) diff.ip_access = changes.ip_access.after;

	return diff;
}

export function computeConfigPlan(current: CairnConfig, desired: CairnConfig): ConfigPlan {
	const plan: ConfigPlan = {
		roles: { create: [], update: [], delete: [] },
		permissions: { create: [], update: [], delete: [] },
	};

	const managed = new Set<ConfigKind>(desired.manifest.resources);

	if (managed.has('roles')) {
		const currentRolesByKey = new Map(current.roles.map((r) => [r.key, r]));
		const desiredRolesByKey = new Map(desired.roles.map((r) => [r.key, r]));

		for (const desiredRole of desired.roles) {
			const currentRole = currentRolesByKey.get(desiredRole.key);

			if (!currentRole) {
				plan.roles.create.push(desiredRole);
			} else {
				const changes = roleChanges(currentRole, desiredRole);

				if (Object.keys(changes).length > 0) {
					plan.roles.update.push({ key: desiredRole.key, diff: roleDiffFromChanges(changes), changes });
				}
			}
		}

		for (const currentRole of current.roles) {
			if (!desiredRolesByKey.has(currentRole.key)) {
				plan.roles.delete.push(currentRole.key);
			}
		}
	}

	if (managed.has('permissions')) {
		const currentPermsByKey = new Map<string, ConfigPermission>();

		for (const permSet of current.permissions) {
			for (const perm of permSet.permissions) {
				currentPermsByKey.set(permKey(permSet.role, perm), perm);
			}
		}

		const desiredPermKeys = new Set<string>();

		for (const permSet of desired.permissions) {
			for (const perm of permSet.permissions) {
				const key = permKey(permSet.role, perm);
				desiredPermKeys.add(key);

				const currentPerm = currentPermsByKey.get(key);

				if (!currentPerm) {
					plan.permissions.create.push({ roleKey: permSet.role, permission: perm });
				} else {
					const changes = permChanges(currentPerm, perm);

					if (Object.keys(changes).length > 0) {
						plan.permissions.update.push({ roleKey: permSet.role, permission: perm, changes });
					}
				}
			}
		}

		const deletedRoleKeys = new Set(plan.roles.delete);

		for (const permSet of current.permissions) {
			// Role deletion cascades to its permissions, so the plan does not list them separately.
			if (deletedRoleKeys.has(permSet.role)) continue;

			for (const perm of permSet.permissions) {
				const key = permKey(permSet.role, perm);

				if (!desiredPermKeys.has(key)) {
					plan.permissions.delete.push({
						roleKey: permSet.role,
						collection: perm.collection,
						action: perm.action,
					});
				}
			}
		}
	}

	return plan;
}

export function validateConfigPlan(
	plan: ConfigPlan,
	desired: CairnConfig,
	context: { currentRoles: Map<string, { admin_access: boolean }> }
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];

	if (plan.roles.delete.length > 0) {
		const deletedKeys = new Set(plan.roles.delete);

		const remainingAdminCount = [...context.currentRoles.entries()].filter(([key, role]) => {
			if (deletedKeys.has(key)) return false;
			return role.admin_access;
		}).length;

		const desiredAdminCount = desired.roles.filter((r) => {
			if (deletedKeys.has(r.key)) return false;
			return r.admin_access;
		}).length;

		if (remainingAdminCount + desiredAdminCount === 0) {
			failures.push({ code: 'CONFIG_PROTECTED_RECORD', message: 'Cannot delete the last admin role.' });
		}
	}

	return failures;
}
