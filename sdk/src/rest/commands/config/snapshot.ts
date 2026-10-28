import type { RestCommand } from '../../types.js';

export type ConfigKindV1 = 'roles' | 'permissions';

export type ConfigKindV2 = ConfigKindV1 | 'folders' | 'settings' | 'extension-settings' | 'translations';

export type ConfigKindV3 = ConfigKindV2 | 'schema';

export type ConfigDocumentV1 = {
	manifest: { version: 1; resources: ConfigKindV1[] };
	roles: Record<string, any>[];
	permissions: Record<string, any>[];
};

export type ConfigDocumentV2 = {
	manifest: { version: 2; resources: ConfigKindV2[] };
	roles: Record<string, any>[];
	permissions: Record<string, any>[];
	folders: Record<string, any>[];
	settings: Record<string, any>[];
	'extension-settings': Record<string, any>[];
	translations: Record<string, any>[];
};

export type ConfigDocumentV3 = {
	manifest: { version: 3; resources: ConfigKindV3[]; schema?: { release: string; vendor: string } };
	roles: Record<string, any>[];
	permissions: Record<string, any>[];
	folders: Record<string, any>[];
	settings: Record<string, any>[];
	'extension-settings': Record<string, any>[];
	translations: Record<string, any>[];
	schema: Record<string, any>[];
};

/** A config-as-code document. It has one array for every resource kind its manifest version supports. */
export type ConfigDocument = ConfigDocumentV1 | ConfigDocumentV2 | ConfigDocumentV3;

export type ConfigSnapshotOptions = {
	manifestVersion?: 1 | 2 | 3;
	resources?: ConfigKindV3[];
};

/**
 * Retrieve the current configuration as a version 1 config document. This endpoint is only available to admin users.
 * @param options The resources to manage, all version 1 kinds by default. An empty list manages none.
 * @returns Returns the version 1 config document.
 */
export function configSnapshot<Schema>(options: {
	manifestVersion: 1;
	resources?: ConfigKindV1[];
}): RestCommand<ConfigDocumentV1, Schema>;

/**
 * Retrieve the current configuration as a version 2 config document. This endpoint is only available to admin users.
 * @param options The resources to manage, all version 2 kinds by default. An empty list manages none.
 * @returns Returns the version 2 config document.
 */
export function configSnapshot<Schema>(options: {
	manifestVersion: 2;
	resources?: ConfigKindV2[];
}): RestCommand<ConfigDocumentV2, Schema>;

/**
 * Retrieve the current configuration as a version 3 config document, the server default. This endpoint is only available to admin users.
 * @param options The resources to manage, all version 3 kinds by default. An empty list manages none.
 * @returns Returns the version 3 config document.
 */
export function configSnapshot<Schema>(options?: {
	manifestVersion?: 3;
	resources?: ConfigKindV3[];
}): RestCommand<ConfigDocumentV3, Schema>;

/**
 * Retrieve the current configuration as a config document. This endpoint is only available to admin users.
 * @param options The manifest version, 3 by default, and the resources to manage, all of that version's kinds by default.
 * @returns Returns the config document for the requested manifest version.
 */
export function configSnapshot<Schema>(options?: ConfigSnapshotOptions): RestCommand<ConfigDocument, Schema>;

export function configSnapshot<Schema>(options: ConfigSnapshotOptions = {}): RestCommand<ConfigDocument, Schema> {
	return () => {
		const params: Record<string, string> = {};

		if (options.manifestVersion !== undefined) params['manifest_version'] = String(options.manifestVersion);
		if (options.resources !== undefined) params['resources'] = options.resources.join(',');

		return {
			method: 'GET',
			path: '/config/snapshot',
			params,
		};
	};
}
