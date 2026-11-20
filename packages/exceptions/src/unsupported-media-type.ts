import { BaseException } from './base.js';

export class UnsupportedMediaTypeException extends BaseException<Record<string, unknown>> {
	constructor(message: string, extensions?: Record<string, unknown>) {
		super(message, 415, 'UNSUPPORTED_MEDIA_TYPE', extensions);
	}
}
