import { BaseException } from './base.js';

export class InvalidPayloadException extends BaseException<Record<string, unknown>> {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 400, 'INVALID_PAYLOAD', extensions);
	}
}
