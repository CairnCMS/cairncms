import { BaseException } from '@cairncms/exceptions';

export class ConfigFolderInUseException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_FOLDER_IN_USE', extensions);
	}
}
