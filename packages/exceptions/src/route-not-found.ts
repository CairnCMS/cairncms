import { BaseException } from './base.js';

export class RouteNotFoundException extends BaseException<Record<string, unknown>> {
	constructor(path: string) {
		super(`Route ${path} doesn't exist.`, 404, 'ROUTE_NOT_FOUND');
	}
}
