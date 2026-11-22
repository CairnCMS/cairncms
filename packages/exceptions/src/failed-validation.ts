import { BaseException } from './base.js';
import {
	joiValidationErrorItemToErrorExtensions,
	type FailedValidationExtensions,
	type FailedValidationType,
	type ValidationErrorItem,
} from './joi-to-error-extensions.js';

const RULE_SENTENCES: Record<FailedValidationType, string> = {
	eq: 'Value has to be the required value.',
	neq: `Value can't be the excluded value.`,
	in: 'Value has to be one of the allowed values.',
	nin: `Value can't be one of the excluded values.`,
	null: 'Value has to be null.',
	nnull: `Value can't be null.`,
	empty: 'Value has to be empty.',
	nempty: `Value can't be empty.`,
	gt: 'Value has to be greater than the minimum.',
	gte: 'Value has to be greater than or equal to the minimum.',
	lt: 'Value has to be less than the maximum.',
	lte: 'Value has to be less than or equal to the maximum.',
	contains: 'Value has to contain the required text.',
	ncontains: `Value can't contain the excluded text.`,
	required: 'Value is required.',
	regex: `Value doesn't have the correct format.`,
	starts_with: 'Value has to start with the required text.',
	nstarts_with: `Value can't start with the excluded text.`,
	ends_with: 'Value has to end with the required text.',
	nends_with: `Value can't end with the excluded text.`,
	istarts_with: 'Value has to start with the required text.',
	nistarts_with: `Value can't start with the excluded text.`,
	iends_with: 'Value has to end with the required text.',
	niends_with: `Value can't end with the excluded text.`,
};

function failedValidationMessage({ field, type }: FailedValidationExtensions): string {
	const prefix = field === undefined ? 'Validation failed.' : `Validation failed for field "${field}".`;
	return type ? `${prefix} ${RULE_SENTENCES[type]}` : prefix;
}

export class FailedValidationException extends BaseException<FailedValidationExtensions> {
	constructor(error: ValidationErrorItem) {
		const extensions = joiValidationErrorItemToErrorExtensions(error);
		super(failedValidationMessage(extensions), 400, 'FAILED_VALIDATION', extensions);
	}
}
