import { BaseException } from './base.js';

type Extensions = {
	allow: string[];
};

export class MethodNotAllowedException extends BaseException<Extensions> {
	constructor(message = 'Method not allowed.', extensions: Extensions) {
		super(message, 405, 'METHOD_NOT_ALLOWED', extensions);
	}
}
