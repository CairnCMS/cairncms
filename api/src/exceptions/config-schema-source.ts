import { BaseException } from '@cairncms/exceptions';

export class ConfigSchemaSourceException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_SCHEMA_SOURCE', extensions);
	}
}
