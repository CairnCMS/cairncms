import { BaseException } from '@cairncms/exceptions';

export class InvalidIPException extends BaseException<Record<string, unknown>> {
	constructor(message = 'Invalid IP address.') {
		super(message, 401, 'INVALID_IP');
	}
}
