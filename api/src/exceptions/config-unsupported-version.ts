import { BaseException } from '@cairncms/exceptions';

/** Manifest declares a format version this build does not support. The 503 `InvalidConfigException` reports deployment misconfiguration instead. */
export class ConfigUnsupportedVersionException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_UNSUPPORTED_VERSION', extensions);
	}
}
