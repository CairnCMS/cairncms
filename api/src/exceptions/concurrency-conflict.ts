import { BaseException } from '@cairncms/exceptions';

export class ConcurrencyConflictException extends BaseException {
	constructor(extensions?: Record<string, unknown>) {
		super(
			'The record was modified concurrently and the change was not applied. Reread the current state and retry.',
			409,
			'CONCURRENCY_CONFLICT',
			extensions
		);
	}
}
