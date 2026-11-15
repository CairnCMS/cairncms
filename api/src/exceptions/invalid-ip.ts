import { BaseException } from '@cairncms/exceptions';

export class InvalidIPException extends BaseException<Record<string, never>> {
	constructor(message = 'Invalid IP address.') {
		super(message, 401, 'INVALID_IP');
	}
}
