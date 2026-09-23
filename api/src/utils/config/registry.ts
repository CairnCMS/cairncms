import { CONFIG_KINDS, type ConfigKind } from '../../types/config.js';
import type { ManifestVersion } from '../config-contract.js';
import type { ConfigResourceDescriptor } from './descriptor.js';
import { extensionSettingsDescriptor, type ExtensionSettingsKindTypes } from './handlers/extension-settings.js';
import { foldersDescriptor, type FoldersKindTypes } from './handlers/folders.js';
import { permissionsDescriptor, type PermissionsKindTypes } from './handlers/permissions.js';
import { rolesDescriptor, type RolesKindTypes } from './handlers/roles.js';
import { settingsDescriptor, type SettingsKindTypes } from './handlers/settings.js';
import { translationsDescriptor, type TranslationsKindTypes } from './handlers/translations.js';

export type ConfigKindTypeMap = {
	roles: RolesKindTypes;
	permissions: PermissionsKindTypes;
	folders: FoldersKindTypes;
	settings: SettingsKindTypes;
	'extension-settings': ExtensionSettingsKindTypes;
	translations: TranslationsKindTypes;
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

/** Runs kind-specific work while preserving the correlation between a kind and its descriptor bundle. */
export function forKind<C extends ConfigKind, R>(kind: C, fn: (descriptor: (typeof CONFIG_REGISTRY)[C]) => R): R {
	return fn(CONFIG_REGISTRY[kind]);
}
