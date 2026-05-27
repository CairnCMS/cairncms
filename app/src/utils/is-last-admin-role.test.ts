import { describe, expect, it } from 'vitest';
import { isLastAdminRole } from './is-last-admin-role';

describe('isLastAdminRole', () => {
	it('returns null when roles have not loaded yet', () => {
		expect(isLastAdminRole(null, 'role-1')).toBe(null);
	});

	it('returns true when the queried role is the only admin role', () => {
		const roles = [
			{ id: 'role-1', admin_access: true },
			{ id: 'role-2', admin_access: false },
		];

		expect(isLastAdminRole(roles, 'role-1')).toBe(true);
	});

	it('returns false when the queried role is admin but other admins exist', () => {
		const roles = [
			{ id: 'role-1', admin_access: true },
			{ id: 'role-2', admin_access: true },
		];

		expect(isLastAdminRole(roles, 'role-1')).toBe(false);
	});

	it('returns false when the queried role is not admin', () => {
		const roles = [
			{ id: 'role-1', admin_access: true },
			{ id: 'role-2', admin_access: false },
		];

		expect(isLastAdminRole(roles, 'role-2')).toBe(false);
	});

	it('returns false when the primaryKey is not in the roles list', () => {
		const roles = [{ id: 'role-1', admin_access: true }];
		expect(isLastAdminRole(roles, 'role-missing')).toBe(false);
	});
});
