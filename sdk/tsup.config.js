import { defineConfig } from 'tsup';
import { replace } from 'esbuild-plugin-replace';

// Reserved system collection names. Used at build time only: the SDK source
// references __SYSTEM_COLLECTION_NAMES__ as a placeholder, and this array is
// inlined into the bundle via esbuild-plugin-replace.
//
// This list MUST match the `collection:` entries under `data:` in
// api/src/database/system-data/collections/collections.yaml. If a system
// collection is added to or removed from the API, update this list to match.
const systemCollectionNames = [
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
	'directus_webhooks',
	'directus_dashboards',
	'directus_panels',
	'directus_notifications',
	'directus_shares',
	'directus_flows',
	'directus_operations',
];

const env = process.env.NODE_ENV;

export default defineConfig(() => ({
	sourcemap: env === 'production',
	clean: true,
	dts: true,
	format: ['cjs', 'esm'],
	minify: env === 'production',
	watch: env === 'development',
	bundle: true,
	target: 'es2020',
	entry: ['src/index.ts'],
	esbuildPlugins: [
		replace({
			__SYSTEM_COLLECTION_NAMES__: JSON.stringify(systemCollectionNames),
		}),
	],
}));
