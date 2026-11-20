import { BaseException } from './base.js';

type Extensions = {
	service?: string | undefined;
	message?: string | undefined;
	[key: string]: any;
};

export class ServiceUnavailableException extends BaseException<Extensions> {
	constructor(message: string, extensions?: Extensions) {
		super(message, 503, 'SERVICE_UNAVAILABLE', extensions);
	}
}
