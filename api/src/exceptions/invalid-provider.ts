import { BaseException } from '@cairncms/exceptions';

export class InvalidProviderException extends BaseException<Record<string, unknown>> {
	constructor(message = 'Invalid provider.') {
		super(message, 403, 'INVALID_PROVIDER');
	}
}
