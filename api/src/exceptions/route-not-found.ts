import { BaseException } from '@cairncms/exceptions';

export class RouteNotFoundException extends BaseException<Record<string, never>> {
	constructor(path: string) {
		super(`Route ${path} doesn't exist.`, 404, 'ROUTE_NOT_FOUND');
	}
}
