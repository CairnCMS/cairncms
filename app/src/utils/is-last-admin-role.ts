type Role = { id: string; admin_access: boolean };

export function isLastAdminRole(roles: Role[] | null, primaryKey: string): boolean | null {
	if (roles === null) return null;

	const adminRoles = roles.filter((role) => role.admin_access === true);

	if (adminRoles.length !== 1) return false;

	return adminRoles[0]!.id === primaryKey;
}
