import { BaseException } from './base.js';

type Extensions = {
	limit: number;
	reset: Date;
};

export class HitRateLimitException extends BaseException<Extensions> {
	constructor(message: string, extensions: Extensions) {
		super(message, 429, 'REQUESTS_EXCEEDED', extensions);
	}
}
