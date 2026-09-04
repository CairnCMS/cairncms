import { BaseException } from '@cairncms/exceptions';

/**
 * Config state could not be read for any reason other than absence, so the read never degrades into
 * an empty result. The 503 `InvalidConfigException` reports deployment misconfiguration instead.
 */
export class ConfigReadFailedException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 500, 'CONFIG_READ_FAILED', extensions);
	}
}
