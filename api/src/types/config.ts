import type { PermissionsAction } from '@cairncms/types';

export interface ConfigRole {
	key: string;
	name: string;
	icon?: string;
	description?: string;
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
	resources: Array<'roles' | 'permissions'>;
}

export interface CairnConfig {
	manifest: ConfigManifest;
	roles: ConfigRole[];
	permissions: ConfigPermissionSet[];
}

export interface ConfigPlan {
	roles: {
		create: ConfigRole[];
		update: Array<{ key: string; diff: Partial<ConfigRole> }>;
		delete: string[];
	};
	permissions: {
		create: Array<{ roleKey: string; permission: ConfigPermission }>;
		update: Array<{ roleKey: string; permission: ConfigPermission }>;
		delete: Array<{ roleKey: string; collection: string; action: PermissionsAction }>;
	};
}

export interface ConfigPlanErrors {
	errors: string[];
}

export interface ApplyResult {
	roles: { created: string[]; updated: string[]; deleted: string[] };
	permissions: { created: number; updated: number; deleted: number };
}
