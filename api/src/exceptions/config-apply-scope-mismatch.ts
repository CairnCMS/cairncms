import { BaseException } from '@cairncms/exceptions';

export class ConfigApplyScopeMismatchException extends BaseException {
	constructor() {
		super(
			'The config apply was refused because its plan and its state token cover different managed resources.',
			500,
			'CONFIG_APPLY_SCOPE_MISMATCH'
		);
	}
}
