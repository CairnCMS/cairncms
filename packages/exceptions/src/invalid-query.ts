import { BaseException } from './base.js';

export class InvalidQueryException extends BaseException<Record<string, unknown>> {
	constructor(message: string) {
		super(message, 400, 'INVALID_QUERY');
	}
}
