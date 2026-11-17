import { BaseException } from './base.js';

export class InvalidCredentialsException extends BaseException<Record<string, unknown>> {
	constructor(message = 'Invalid user credentials.') {
		super(message, 401, 'INVALID_CREDENTIALS');
	}
}
