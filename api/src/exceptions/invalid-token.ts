import { BaseException } from '@cairncms/exceptions';

export class InvalidTokenException extends BaseException<Record<string, never>> {
	constructor(message = 'Invalid token') {
		super(message, 403, 'INVALID_TOKEN');
	}
}
