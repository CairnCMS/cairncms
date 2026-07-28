import { BaseException } from '@cairncms/exceptions';

/** A placeholder inside the supported namespace has no value in the environment. The 503 `InvalidConfigException` reports deployment misconfiguration instead. */
export class ConfigPlaceholderUnresolvedException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'CONFIG_PLACEHOLDER_UNRESOLVED', extensions);
	}
}
