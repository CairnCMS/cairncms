import { CONFIG_KINDS, type ConfigKind } from '../../types/config.js';
import type { ConfigResourceDescriptor } from './descriptor.js';
import { permissionsDescriptor, type PermissionsKindTypes } from './handlers/permissions.js';
import { rolesDescriptor, type RolesKindTypes } from './handlers/roles.js';

export type ConfigKindTypeMap = {
	roles: RolesKindTypes;
	permissions: PermissionsKindTypes;
};

export type ConfigRegistry = {
	[C in ConfigKind]: ConfigResourceDescriptor<ConfigKindTypeMap[C]>;
};

export const CONFIG_REGISTRY = {
	roles: rolesDescriptor,
	permissions: permissionsDescriptor,
} satisfies ConfigRegistry;

export function getDescriptor<C extends ConfigKind>(kind: C): (typeof CONFIG_REGISTRY)[C] {
	return CONFIG_REGISTRY[kind];
}

export function listConfigKinds(): ConfigKind[] {
	return [...CONFIG_KINDS];
}

/** Runs kind-specific work while preserving the correlation between a kind and its descriptor bundle. */
export function forKind<C extends ConfigKind, R>(kind: C, fn: (descriptor: (typeof CONFIG_REGISTRY)[C]) => R): R {
	return fn(CONFIG_REGISTRY[kind]);
}
