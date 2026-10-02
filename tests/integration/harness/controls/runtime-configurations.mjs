export const runtimeConfigurations = {
	cache: {
		reason: 'Memory caches belong to the process; these settings do not change migrations, seeds or initial rows.',
		env: {
			CACHE_SCHEMA: 'false',
			CACHE_ENABLED: 'true',
			CACHE_AUTO_PURGE: 'true',
			CACHE_AUTO_PURGE_IGNORE_LIST: 'directus_activity,directus_presets',
			CACHE_STORE: 'memory',
			CACHE_STATUS_HEADER: 'x-fixture-cache',
			CACHE_NAMESPACE: 'fixture-cache',
		},
	},
	files: {
		reason: 'Upload validation and transform concurrency apply to requests, not initial database contents.',
		env: {
			FILES_MAX_UPLOAD_SIZE: '1mb',
			FILES_MIME_TYPE_ALLOW_LIST: 'image/png',
			ASSETS_TRANSFORM_MAX_CONCURRENT: '1',
		},
	},
	storage: {
		reason: 'Storage locations configure clients; bootstrap does not create file rows or stored objects.',
		keys: [
			'STORAGE_LOCATIONS',
			'STORAGE_S3_DRIVER',
			'STORAGE_S3_KEY',
			'STORAGE_S3_SECRET',
			'STORAGE_S3_BUCKET',
			'STORAGE_S3_REGION',
			'STORAGE_S3_ENDPOINT',
			'STORAGE_S3_FORCE_PATH_STYLE',
		],
	},
};
