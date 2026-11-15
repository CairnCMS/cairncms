import { BaseException } from '@cairncms/exceptions';

export class InvalidQueryException extends BaseException<Record<string, never>> {
	constructor(message: string) {
		super(message, 400, 'INVALID_QUERY');
	}
}
