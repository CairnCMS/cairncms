import { BaseException } from '@cairncms/exceptions';

export class ConfigProtectedRecordException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_PROTECTED_RECORD', extensions);
	}
}
