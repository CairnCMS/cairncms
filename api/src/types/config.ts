import type { Accountability, PermissionsAction } from '@cairncms/types';
import type { ManifestVersion } from '../utils/config-contract.js';
import type { ConfigKindTypeMap } from '../utils/config/registry.js';

export const CONFIG_KINDS = ['roles', 'permissions', 'folders'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

export interface ConfigRole {
	key: string;
	name: string;
	icon?: string;
	description?: string | null;
	admin_access: boolean;
	app_access: boolean;
	enforce_tfa?: boolean;
	ip_access?: string[] | null;
}

export interface ConfigPermissionSet {
	role: string;
	permissions: ConfigPermission[];
}

export interface ConfigPermission {
	collection: string;
	action: PermissionsAction;
	permissions: Record<string, any> | null;
	validation: Record<string, any> | null;
	presets: Record<string, any> | null;
	fields: string[] | null;
}

export interface ConfigFolder {
	key: string;
	name: string;
	parent: string | null;
}

export interface ConfigManifest {
	version: ManifestVersion;
	resources: ConfigKind[];
}

export interface CairnConfig {
	manifest: ConfigManifest;
	roles: ConfigRole[];
	permissions: ConfigPermissionSet[];
	folders: ConfigFolder[];
}

export type RoleIdentity = { key: string };

export type FolderIdentity = { key: string };

export type FolderValues = {
	name: string;
	parent: string | null;
};

export type FolderFieldChanges = { [K in keyof FolderValues]?: FieldChange<FolderValues[K]> };

export type FieldChange<T> = { before: T; after: T };

export type RoleValues = {
	name: string;
	icon: string;
	description: string | null;
	admin_access: boolean;
	app_access: boolean;
	enforce_tfa: boolean;
	ip_access: string[] | null;
};

export type PermissionValues = {
	permissions: Record<string, unknown> | null;
	validation: Record<string, unknown> | null;
	presets: Record<string, unknown> | null;
	fields: string[] | null;
};

export type RoleFieldChanges = { [K in keyof RoleValues]?: FieldChange<RoleValues[K]> };
export type PermissionFieldChanges = { [K in keyof PermissionValues]?: FieldChange<PermissionValues[K]> };

export type ProtectionContributor = { kind: 'roles'; operation: 'update' | 'delete'; identity: RoleIdentity };

export type ConfigProtection = {
	code: 'ADMIN_CONTINUITY_REQUIRED';
	message: string;
	contributors: ProtectionContributor[];
};

/** The precondition value binding a plan or apply to the state its read closure was computed from. */
export type ConfigStateToken = Readonly<{ resources: readonly ConfigKind[]; digest: string }>;

export interface ConfigPlan {
	managedResources: readonly ConfigKind[];
	roles: {
		create: ConfigRole[];
		update: Array<{ key: string; changes: RoleFieldChanges }>;
		delete: string[];
	};
	permissions: {
		create: Array<{ roleKey: string; permission: ConfigPermission }>;
		update: Array<{ roleKey: string; collection: string; action: PermissionsAction; changes: PermissionFieldChanges }>;
		delete: Array<{ roleKey: string; collection: string; action: PermissionsAction }>;
	};
	folders: {
		create: ConfigFolder[];
		update: Array<{ key: string; changes: FolderFieldChanges }>;
		delete: string[];
	};
	protections: ConfigProtection[];
}

export type PermissionIdentity = { role: string; collection: string; action: PermissionsAction };

export type ConfigPlanWarning = {
	code: 'COLLECTION_MISSING';
	kind: 'permissions';
	identity: PermissionIdentity;
	message: string;
};

export type RoleDeletionImpactEntry =
	| { kind: 'permissions'; identity: PermissionIdentity }
	| { kind: 'presets'; count: number; bookmarks: string[] }
	| { kind: 'users'; suspended: string[] }
	| { kind: 'sessions'; active: number };

export interface ConfigPlanEnrichment {
	roleDeletionImpact: Map<string, RoleDeletionImpactEntry[]>;
	warnings: ConfigPlanWarning[];
}

export type ConfigPlanChange =
	| { kind: 'roles'; operation: 'create'; identity: RoleIdentity; values: RoleValues }
	| { kind: 'roles'; operation: 'update'; identity: RoleIdentity; fields: RoleFieldChanges }
	| { kind: 'roles'; operation: 'delete'; identity: RoleIdentity; impact: RoleDeletionImpactEntry[] }
	| { kind: 'permissions'; operation: 'create'; identity: PermissionIdentity; values: PermissionValues }
	| { kind: 'permissions'; operation: 'update'; identity: PermissionIdentity; fields: PermissionFieldChanges }
	| { kind: 'permissions'; operation: 'delete'; identity: PermissionIdentity; impact: [] }
	| { kind: 'folders'; operation: 'create'; identity: FolderIdentity; values: FolderValues }
	| { kind: 'folders'; operation: 'update'; identity: FolderIdentity; fields: FolderFieldChanges }
	| { kind: 'folders'; operation: 'delete'; identity: FolderIdentity; impact: [] };

export type SerializedConfigPlan = {
	planVersion: 2;
	manifestVersion: number;
	changes: ConfigPlanChange[];
	summary: { create: number; update: number; delete: number };
	warnings: ConfigPlanWarning[];
	protections: ConfigProtection[];
};

export type ConfigFailureCode = 'CONFIG_INVALID' | 'CONFIG_IDENTITY_CONFLICT';

export type ConfigFailure = { code: ConfigFailureCode; message: string };

export type ApplyResult = { [C in ConfigKind]: ConfigKindTypeMap[C]['ResultSlice'] };

export type ConfigApplySecurityContext =
	| { mode: 'request'; accountability: Accountability }
	| { mode: 'system'; reason: 'local config apply'; accountability: Accountability };
