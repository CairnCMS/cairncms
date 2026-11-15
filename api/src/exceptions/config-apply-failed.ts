import { BaseException } from '@cairncms/exceptions';

export class ConfigApplyFailedException extends BaseException<Record<string, never>> {
	constructor() {
		super(
			'The configuration apply failed and was rolled back. Retry the operation and report the failure if it persists.',
			500,
			'CONFIG_APPLY_FAILED'
		);
	}
}
