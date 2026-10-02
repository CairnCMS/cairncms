import { BaseException } from '@cairncms/exceptions';

export class DestructiveChangesRequiredException extends BaseException {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'DESTRUCTIVE_CHANGES_REQUIRED', extensions);
	}
}
