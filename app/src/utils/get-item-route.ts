/**
 * Only correct for system collections routed at `/<name>/:pk`: users, files, activity.
 * Roles, folders and presets have bespoke module routes and need module-specific handling.
 */
export function getItemRoute(collection: string | null, primaryKey: string | number) {
	if (collection === null) return '';

	const route = collection.startsWith('directus_') ? collection.substring(9) : `content/${collection}`;

	return `/${route}/${primaryKey}`;
}
