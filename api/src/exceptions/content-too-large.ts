import { BaseException } from '@cairncms/exceptions';

export class ContentTooLargeException extends BaseException<Record<string, unknown>> {
	constructor(message: string) {
		super(message, 413, 'CONTENT_TOO_LARGE');
	}
}
