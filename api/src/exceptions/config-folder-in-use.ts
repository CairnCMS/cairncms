import { BaseException } from '@cairncms/exceptions';

export type FolderBlocker = 'files' | 'folders' | 'storage_default_folder' | 'options.folder';

type Extensions = { blockedBy: FolderBlocker } | { key: string; blockedBy?: FolderBlocker };

export class ConfigFolderInUseException extends BaseException<Partial<{ blockedBy: FolderBlocker; key: string }>> {
	constructor(message: string, extensions?: Extensions) {
		super(message, 400, 'CONFIG_FOLDER_IN_USE', extensions);
	}
}
