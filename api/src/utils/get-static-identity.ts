import type { Knex } from 'knex';

export type StaticIdentityRow = {
	status: string;
	token: string | null;
	role: string | null;
	admin: boolean;
	app: boolean;
};

export async function getStaticIdentityById(
	userId: string,
	deps: { database: Knex }
): Promise<StaticIdentityRow | null> {
	const row = await deps.database
		.select(
			'directus_users.status',
			'directus_users.token',
			'directus_users.role',
			'directus_roles.admin_access',
			'directus_roles.app_access'
		)
		.from('directus_users')
		.leftJoin('directus_roles', 'directus_users.role', 'directus_roles.id')
		.where({ 'directus_users.id': userId })
		.first();

	if (!row) return null;

	return {
		status: row.status,
		token: row.token,
		role: row.role,
		admin: row.admin_access === true || row.admin_access == 1,
		app: row.app_access === true || row.app_access == 1,
	};
}
