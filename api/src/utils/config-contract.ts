import type { PermissionsAction } from '@cairncms/types';

export const SUPPORTED_MANIFEST_VERSION = 1;

/** The `Record` check makes a new `PermissionsAction` member a compile-time error here. */
export const SUPPORTED_ACTIONS: ReadonlySet<string> = new Set(
	Object.keys({
		create: true,
		read: true,
		update: true,
		delete: true,
		comment: true,
		explain: true,
		share: true,
	} satisfies Record<PermissionsAction, true>)
);

export const CONFIG_APPLY_ORIGIN = 'config-cli';

/** These limits mirror the corresponding database columns. */
export const ROLE_KEY_MAX_LENGTH = 255;
export const ROLE_NAME_MAX_LENGTH = 100;
export const ROLE_ICON_MAX_LENGTH = 30;
export const PERMISSION_COLLECTION_MAX_LENGTH = 64;
