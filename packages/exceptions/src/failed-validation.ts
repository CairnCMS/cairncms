import { BaseException } from './base.js';
import {
	joiValidationErrorItemToErrorExtensions,
	type FailedValidationExtensions,
	type ValidationErrorItem,
} from './joi-to-error-extensions.js';

export class FailedValidationException extends BaseException<FailedValidationExtensions> {
	constructor(error: ValidationErrorItem) {
		super(error.message, 400, 'FAILED_VALIDATION', joiValidationErrorItemToErrorExtensions(error));
	}
}
