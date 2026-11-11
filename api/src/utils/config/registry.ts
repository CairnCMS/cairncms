import { CONFIG_KINDS, type ConfigKind } from '../../types/config.js';
import type { ManifestVersion } from '../config-contract.js';
import type { ConfigFieldDescriptor, ConfigResourceDescriptor } from './descriptor.js';
import { extensionSettingsDescriptor, type ExtensionSettingsKindTypes } from './handlers/extension-settings.js';
import { foldersDescriptor, type FoldersKindTypes } from './handlers/folders.js';
import { permissionsDescriptor, type PermissionsKindTypes } from './handlers/permissions.js';
import { rolesDescriptor, type RolesKindTypes } from './handlers/roles.js';
import { schemaDescriptor, type SchemaKindTypes } from './handlers/schema.js';
import { settingsDescriptor, type SettingsKindTypes } from './handlers/settings.js';
import { translationsDescriptor, type TranslationsKindTypes } from './handlers/translations.js';

export type ConfigKindTypeMap = {
	roles: RolesKindTypes;
	permissions: PermissionsKindTypes;
	folders: FoldersKindTypes;
	settings: SettingsKindTypes;
	'extension-settings': ExtensionSettingsKindTypes;
	translations: TranslationsKindTypes;
	schema: SchemaKindTypes;
};

export type ConfigRegistry = {
	[C in ConfigKind]: ConfigResourceDescriptor<ConfigKindTypeMap[C]>;
};

export const CONFIG_REGISTRY = {
	roles: rolesDescriptor,
	permissions: permissionsDescriptor,
	folders: foldersDescriptor,
	settings: settingsDescriptor,
	'extension-settings': extensionSettingsDescriptor,
	translations: translationsDescriptor,
	schema: schemaDescriptor,
} satisfies ConfigRegistry;

export function getDescriptor<C extends ConfigKind>(kind: C): (typeof CONFIG_REGISTRY)[C] {
	return CONFIG_REGISTRY[kind];
}

export function listConfigKinds(): ConfigKind[] {
	return [...CONFIG_KINDS];
}

/** The kinds legal at a manifest version: those whose descriptor requires that version or older. */
export function kindsForVersion(version: ManifestVersion): ConfigKind[] {
	return CONFIG_KINDS.filter((kind) => getDescriptor(kind).formatVersion <= version);
}

type VersionedFields = { formatVersion: number; recordFields: ConfigFieldDescriptor[] };

export function fieldsAboveVersion(descriptor: VersionedFields, version: ManifestVersion): ConfigFieldDescriptor[] {
	return descriptor.recordFields.filter((field) => (field.formatVersion ?? descriptor.formatVersion) > version);
}

export function descriptorAtVersion<D extends VersionedFields & { valueFieldOrder: readonly string[] }>(
	descriptor: D,
	version: ManifestVersion
): D {
	const excluded = new Set(fieldsAboveVersion(descriptor, version).map((field) => field.name));
	if (excluded.size === 0) return descriptor;

	return {
		...descriptor,
		recordFields: descriptor.recordFields.filter((field) => !excluded.has(field.name)),
		valueFieldOrder: descriptor.valueFieldOrder.filter((name) => !excluded.has(name)),
	};
}

/** Never mutates the input, because a singleton's documents are its read records, which the state digest reads afterward. */
export function documentAtVersion<T>(descriptor: VersionedFields, document: T, version: ManifestVersion): T {
	const excluded = fieldsAboveVersion(descriptor, version);
	if (excluded.length === 0) return document;

	const copy = { ...(document as Record<string, unknown>) };
	for (const field of excluded) delete copy[field.name];
	return copy as T;
}

/** Runs kind-specific work while preserving the correlation between a kind and its descriptor bundle. */
export function forKind<C extends ConfigKind, R>(kind: C, fn: (descriptor: (typeof CONFIG_REGISTRY)[C]) => R): R {
	return fn(CONFIG_REGISTRY[kind]);
}
