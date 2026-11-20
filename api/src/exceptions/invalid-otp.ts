import { BaseException } from '@cairncms/exceptions';

export class InvalidOTPException extends BaseException<Record<string, unknown>> {
	constructor(message = 'Invalid user OTP.') {
		super(message, 401, 'INVALID_OTP');
	}
}
