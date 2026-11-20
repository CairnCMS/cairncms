import { BaseException } from './base.js';

export class UnprocessableEntityException extends BaseException<Record<string, unknown>> {
	constructor(message: string) {
		super(message, 422, 'UNPROCESSABLE_ENTITY');
	}
}
