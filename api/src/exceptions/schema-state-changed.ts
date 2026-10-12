import { BaseException } from '@cairncms/exceptions';

export class SchemaStateChangedException extends BaseException {
	constructor(extensions?: Record<string, unknown>) {
		super(
			'The schema apply conflicted with a concurrent change and was rolled back. Recompute the diff and re-apply.',
			409,
			'SCHEMA_STATE_CHANGED',
			extensions
		);
	}
}
