import { BaseException } from '@cairncms/exceptions';
import type { SchemaPersistedState } from '../types/index.js';

export type SchemaApplyFailedOptions = {
	cause?: unknown;
	foreignKeysRestored?: boolean;
};

export class SchemaApplyFailedException extends BaseException {
	constructor(persisted: SchemaPersistedState | 'unknown', options?: SchemaApplyFailedOptions) {
		const foreignKeysOff = options?.foreignKeysRestored === false;

		const message = foreignKeysOff
			? 'The schema apply failed and foreign key enforcement could not be restored. Inspect the reported persisted state before retrying.'
			: 'The schema apply failed and may have left changes in place. Inspect the reported persisted state before retrying.';

		super(message, 500, 'SCHEMA_APPLY_FAILED', {
			persisted,
			...(foreignKeysOff && { foreignKeysRestored: false }),
		});

		if (options?.cause !== undefined) {
			Object.defineProperty(this, 'cause', {
				value: options.cause,
				enumerable: false,
				writable: true,
				configurable: true,
			});
		}
	}
}
