import type { PermissionIdentity } from '../../types/config.js';

export function comparePermissionIdentity(a: PermissionIdentity, b: PermissionIdentity): number {
	const byRole = a.role.localeCompare(b.role);
	if (byRole !== 0) return byRole;

	const byCollection = a.collection.localeCompare(b.collection);
	if (byCollection !== 0) return byCollection;

	return a.action.localeCompare(b.action);
}
