import { BaseException } from '@cairncms/exceptions';

export class UnexpectedResponseException extends BaseException<Record<string, unknown>> {
	constructor(message: string) {
		super(message, 503, 'UNEXPECTED_RESPONSE');
	}
}
