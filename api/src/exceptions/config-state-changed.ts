import { BaseException } from '@cairncms/exceptions';

export class ConfigStateChangedException extends BaseException {
	constructor(extensions?: Record<string, unknown>) {
		super(
			'The apply conflicted with a concurrent change and was rolled back. Recompute the plan and re-apply.',
			409,
			'CONFIG_STATE_CHANGED',
			extensions
		);
	}
}
