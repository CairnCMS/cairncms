import { BaseException } from '@cairncms/exceptions';

export class InvalidCredentialsException extends BaseException<Record<string, unknown>> {
	constructor(message = 'Invalid user credentials.') {
		super(message, 401, 'INVALID_CREDENTIALS');
	}
}
