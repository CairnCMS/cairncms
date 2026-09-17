import type { Accountability, PermissionsAction } from '@cairncms/types';
import type { ManifestVersion } from '../utils/config-contract.js';
import type { ConfigKindTypeMap } from '../utils/config/registry.js';

export const CONFIG_KINDS = ['roles', 'permissions', 'folders', 'settings', 'extension-settings'] as const;
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
	parent?: string | null;
}

export interface ConfigSettings {
	project_name?: string;
	project_descriptor?: string | null;
	project_url?: string | null;
	default_language?: string;
	project_color?: string | null;
	public_note?: string | null;
	custom_css?: string | null;
	module_bar?: unknown[] | null;
	auth_password_policy?: string | null;
	auth_login_attempts?: number | null;
	storage_asset_transform?: string | null;
	storage_asset_presets?: unknown[] | null;
	basemaps?: unknown[] | null;
	custom_aspect_ratios?: unknown[] | null;
	mapbox_key?: string | null;
	storage_default_folder?: string | null;
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
	settings: ConfigSettings[];
	'extension-settings': ConfigExtensionSettings[];
}

export type RoleIdentity = { key: string };

export type FolderIdentity = { key: string };

export type FolderValues = {
	name: string;
	parent: string | null;
};

export type FolderFieldChanges = { [K in keyof FolderValues]?: FieldChange<FolderValues[K]> };

export type SettingsIdentity = { key: string };

export type SettingsValues = {
	project_name: string;
	project_descriptor: string | null;
	project_url: string | null;
	default_language: string;
	project_color: string | null;
	public_note: string | null;
	custom_css: string | null;
	module_bar: unknown[] | null;
	auth_password_policy: string | null;
	auth_login_attempts: number | null;
	storage_asset_transform: string | null;
	storage_asset_presets: unknown[] | null;
	basemaps: unknown[] | null;
	custom_aspect_ratios: unknown[] | null;
	mapbox_key: string | null;
	storage_default_folder: string | null;
};

export type SettingsFieldChanges = { [K in keyof SettingsValues]?: FieldChange<SettingsValues[K]> };

/** Whether a plan retargets the default folder, and to which key, so the deletion preview can drop a blocker the same apply clears. */
export type SettingsRetarget = { retargeted: false } | { retargeted: true; toKey: string | null };

export type FieldChange<T> = { before: T; after: T };

export type ExtensionSettingLeaf = string | number | boolean | { $secret: 'preserve' };

/** Declaration metadata belongs to the extension manifest, not this document. */
export interface ConfigExtensionSettings {
	subject: string;
	global: Record<string, ExtensionSettingLeaf>;
	collections: Record<string, Record<string, ExtensionSettingLeaf>>;
}

export type ExtensionSettingsScope = 'global' | 'collection';

export type ExtensionSettingsIdentity = {
	subject: string;
	scope: ExtensionSettingsScope;
	scope_key: string;
	key: string;
};

export type ExtensionSettingsValues = { value: ExtensionSettingLeaf };

export type ExtensionSettingsFieldChanges = {
	[K in keyof ExtensionSettingsValues]?: FieldChange<ExtensionSettingsValues[K]>;
};

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

/** Binds an apply to the state and scope read during planning. */
export type ConfigStateToken = Readonly<{
	resources: readonly ConfigKind[];
	digest: string;
	/** Recheck this scope: absent means all eligible subjects, empty means none. */
	extensionSubjects?: readonly string[];
}>;

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
	settings: {
		create: never[];
		update: Array<{ changes: SettingsFieldChanges }>;
		delete: never[];
	};
	'extension-settings': {
		create: Array<{ identity: ExtensionSettingsIdentity; value: ExtensionSettingLeaf }>;
		update: Array<{ identity: ExtensionSettingsIdentity; changes: ExtensionSettingsFieldChanges }>;
		delete: Array<{ identity: ExtensionSettingsIdentity }>;
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

export type FolderDeletionImpactEntry = {
	blockedBy: 'files' | 'folders' | 'storage_default_folder' | 'options.folder';
};

export interface ConfigPlanEnrichment {
	roleDeletionImpact: Map<string, RoleDeletionImpactEntry[]>;
	folderDeletionImpact: Map<string, FolderDeletionImpactEntry[]>;
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
	| { kind: 'folders'; operation: 'delete'; identity: FolderIdentity; impact: FolderDeletionImpactEntry[] }
	| { kind: 'settings'; operation: 'update'; identity: SettingsIdentity; fields: SettingsFieldChanges }
	| {
			kind: 'extension-settings';
			operation: 'create';
			identity: ExtensionSettingsIdentity;
			values: ExtensionSettingsValues;
	  }
	| {
			kind: 'extension-settings';
			operation: 'update';
			identity: ExtensionSettingsIdentity;
			fields: ExtensionSettingsFieldChanges;
	  }
	| { kind: 'extension-settings'; operation: 'delete'; identity: ExtensionSettingsIdentity; impact: [] };

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
