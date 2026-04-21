import { isEqual } from 'lodash-es';
import type { ConfigPlan, ConfigPlanErrors, ConfigPermission, ConfigRole, CairnConfig } from '../types/config.js';

function permKey(roleKey: string, perm: ConfigPermission): string {
	return `${roleKey}::${perm.collection}::${perm.action}`;
}

function roleChanged(current: ConfigRole, desired: ConfigRole): Partial<ConfigRole> | null {
	const diff: Partial<ConfigRole> = {};
	let hasChanges = false;

	for (const field of ['name', 'icon', 'description', 'admin_access', 'app_access', 'enforce_tfa'] as const) {
		if (!isEqual(current[field], desired[field])) {
			(diff as any)[field] = desired[field];
			hasChanges = true;
		}
	}

	if (!isEqual(current.ip_access ?? null, desired.ip_access ?? null)) {
		diff.ip_access = desired.ip_access ?? null;
		hasChanges = true;
	}

	return hasChanges ? diff : null;
}

function permChanged(current: ConfigPermission, desired: ConfigPermission): boolean {
	return (
		!isEqual(current.permissions, desired.permissions) ||
		!isEqual(current.validation, desired.validation) ||
		!isEqual(current.presets, desired.presets) ||
		!isEqual(current.fields, desired.fields)
	);
}

export function computeConfigPlan(current: CairnConfig, desired: CairnConfig): ConfigPlan {
	const plan: ConfigPlan = {
		roles: { create: [], update: [], delete: [] },
		permissions: { create: [], update: [], delete: [] },
	};

	const currentRolesByKey = new Map(current.roles.map((r) => [r.key, r]));
	const desiredRolesByKey = new Map(desired.roles.map((r) => [r.key, r]));

	for (const desiredRole of desired.roles) {
		const currentRole = currentRolesByKey.get(desiredRole.key);

		if (!currentRole) {
			plan.roles.create.push(desiredRole);
		} else {
			const diff = roleChanged(currentRole, desiredRole);

			if (diff) {
				plan.roles.update.push({ key: desiredRole.key, diff });
			}
		}
	}

	for (const currentRole of current.roles) {
		if (!desiredRolesByKey.has(currentRole.key)) {
			plan.roles.delete.push(currentRole.key);
		}
	}

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
			} else if (permChanged(currentPerm, perm)) {
				plan.permissions.update.push({ roleKey: permSet.role, permission: perm });
			}
		}
	}

	for (const permSet of current.permissions) {
		const roleInDesired = desiredRolesByKey.has(permSet.role) || permSet.role === 'public';
		if (!roleInDesired) continue;

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

	return plan;
}

export function validateConfigPlan(
	plan: ConfigPlan,
	desired: CairnConfig,
	context: { currentRoles: Map<string, { admin_access: boolean }> }
): ConfigPlanErrors {
	const errors: string[] = [];

	if (desired.manifest.version !== 1) {
		errors.push(`Unsupported config version: ${desired.manifest.version}. This engine supports version 1.`);
	}

	for (const role of desired.roles) {
		if (role.key === 'public') {
			errors.push('Role key "public" is reserved for public permissions.');
		}
	}

	const desiredRoleKeys = new Set(desired.roles.map((r) => r.key));

	for (const permSet of desired.permissions) {
		if (permSet.role === 'public') continue;

		if (!desiredRoleKeys.has(permSet.role) && !context.currentRoles.has(permSet.role)) {
			errors.push(`Permission set references role "${permSet.role}" which does not exist in config or database.`);
		}
	}

	const seenTuples = new Set<string>();

	for (const permSet of desired.permissions) {
		for (const perm of permSet.permissions) {
			const key = permKey(permSet.role, perm);

			if (seenTuples.has(key)) {
				errors.push(
					`Duplicate permission: role="${permSet.role}" collection="${perm.collection}" action="${perm.action}".`
				);
			}

			seenTuples.add(key);
		}
	}

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
			errors.push('Cannot delete the last admin role.');
		}
	}

	return { errors };
}
