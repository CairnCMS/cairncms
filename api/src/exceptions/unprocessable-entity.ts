import { BaseException } from '@cairncms/exceptions';

export class UnprocessableEntityException extends BaseException<Record<string, never>> {
	constructor(message: string) {
		super(message, 422, 'UNPROCESSABLE_ENTITY');
	}
}
