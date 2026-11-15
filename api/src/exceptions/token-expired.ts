import { BaseException } from '@cairncms/exceptions';

export class TokenExpiredException extends BaseException<Record<string, never>> {
	constructor(message = 'Token expired.') {
		super(message, 401, 'TOKEN_EXPIRED');
	}
}
