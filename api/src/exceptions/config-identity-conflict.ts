import { BaseException } from '@cairncms/exceptions';

export class ConfigIdentityConflictException extends BaseException<Record<string, unknown>> {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_IDENTITY_CONFLICT', extensions);
	}
}
