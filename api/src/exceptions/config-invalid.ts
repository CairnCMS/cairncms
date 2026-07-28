import { BaseException } from '@cairncms/exceptions';

/** Supplied config is not valid input. The 503 `InvalidConfigException` reports deployment misconfiguration instead. */
export class ConfigInvalidException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_INVALID', extensions);
	}
}
