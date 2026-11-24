import { BaseException } from '@cairncms/exceptions';

export class UserSuspendedException extends BaseException<Record<string, unknown>> {
	constructor(message = 'User suspended.') {
		super(message, 401, 'USER_SUSPENDED');
	}
}
