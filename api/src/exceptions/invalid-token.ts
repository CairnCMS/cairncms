import { BaseException } from '@cairncms/exceptions';

export class InvalidTokenException extends BaseException<Record<string, unknown>> {
	constructor(message = 'Invalid token') {
		super(message, 403, 'INVALID_TOKEN');
	}
}
