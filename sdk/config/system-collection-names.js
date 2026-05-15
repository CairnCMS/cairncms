// Single source of truth for the reserved system collection names.
//
// Used at build time by tsup.config.js (inlined into the bundle as the
// __SYSTEM_COLLECTION_NAMES__ placeholder via esbuild-plugin-replace) and at
// test time by vitest.integration.config.ts (declared as a Vitest `define` so
// the same placeholder resolves when running SDK source directly under
// vitest).
//
// This list MUST match the `collection:` entries under `data:` in
// api/src/database/system-data/collections/collections.yaml. If a system
// collection is added to or removed from the API, update this list.
//
// Not shipped to npm consumers: excluded from `files: [...]` in package.json,
// and no SDK source file imports it at runtime (the placeholder pattern means
// the array is baked into the compiled bundle).

export const systemCollectionNames = [
	'directus_activity',
	'directus_collections',
	'directus_fields',
	'directus_files',
	'directus_folders',
	'directus_migrations',
	'directus_permissions',
	'directus_presets',
	'directus_relations',
	'directus_revisions',
	'directus_roles',
	'directus_sessions',
	'directus_settings',
	'directus_users',
	'directus_dashboards',
	'directus_panels',
	'directus_notifications',
	'directus_shares',
	'directus_flows',
	'directus_operations',
];
