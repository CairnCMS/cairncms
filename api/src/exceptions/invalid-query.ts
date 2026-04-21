import { BaseException } from '@cairncms/exceptions';

export class InvalidQueryException extends BaseException {
	constructor(message: string) {
		super(message, 400, 'INVALID_QUERY');
	}
}
