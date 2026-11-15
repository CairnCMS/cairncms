import { BaseException } from '@cairncms/exceptions';

export class InvalidQueryException extends BaseException<Record<string, unknown>> {
	constructor(message: string) {
		super(message, 400, 'INVALID_QUERY');
	}
}
