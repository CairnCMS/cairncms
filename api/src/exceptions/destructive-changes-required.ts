import { BaseException } from '@cairncms/exceptions';
import type { PlanDeletion } from '../utils/config/plan-folds.js';

type Extensions = {
	deletions: PlanDeletion[];
};

export class DestructiveChangesRequiredException extends BaseException<Partial<Extensions>> {
	constructor(message: string, extensions?: Extensions) {
		super(message, 400, 'DESTRUCTIVE_CHANGES_REQUIRED', extensions);
	}
}
