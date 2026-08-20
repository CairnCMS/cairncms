import type { PermissionsAction } from '@cairncms/types';

export const CONFIG_KINDS = ['roles', 'permissions'] as const;
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

export interface ConfigManifest {
	version: 1;
	resources: ConfigKind[];
}

export interface CairnConfig {
	manifest: ConfigManifest;
	roles: ConfigRole[];
	permissions: ConfigPermissionSet[];
}

export type RoleIdentity = { key: string };

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

export interface ConfigPlan {
	roles: {
		create: ConfigRole[];
		update: Array<{ key: string; diff: Partial<ConfigRole>; changes: RoleFieldChanges }>;
		delete: string[];
	};
	permissions: {
		create: Array<{ roleKey: string; permission: ConfigPermission }>;
		update: Array<{ roleKey: string; permission: ConfigPermission; changes: PermissionFieldChanges }>;
		delete: Array<{ roleKey: string; collection: string; action: PermissionsAction }>;
	};
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
	| { kind: 'permissions'; operation: 'delete'; identity: PermissionIdentity; impact: [] };

export type SerializedConfigPlan = {
	planVersion: 1;
	manifestVersion: number;
	changes: ConfigPlanChange[];
	summary: { create: number; update: number; delete: number };
	warnings: ConfigPlanWarning[];
};

export type ConfigFailureCode = 'CONFIG_INVALID' | 'CONFIG_IDENTITY_CONFLICT' | 'CONFIG_PROTECTED_RECORD';

export type ConfigFailure = { code: ConfigFailureCode; message: string };

export interface ApplyResult {
	roles: { created: string[]; updated: string[]; deleted: string[] };
	permissions: { created: number; updated: number; deleted: number };
}
