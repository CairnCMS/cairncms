import { describe, expect, it } from 'vitest';
import { FailedValidationException } from './failed-validation.js';
import { joiValidationErrorItemToErrorExtensions, type ValidationErrorItem } from './joi-to-error-extensions.js';

const items: ValidationErrorItem[] = [
	{ message: '"title" must be [a]', path: ['title'], type: 'any.only', context: { valids: ['a'], value: 'b' } },
	{ message: '"title" contains an invalid value', path: ['title'], type: 'any.invalid', context: { invalids: [null] } },
	{ message: '"title" is required', path: ['title'], type: 'any.required', context: {} },
	{ message: '"title" must be a string', path: ['title'], type: 'string.base', context: { value: 42 } },
];

describe('joiValidationErrorItemToErrorExtensions', () => {
	it.each(items)('gives the same details as FailedValidationException for $type', (item) => {
		const error = new FailedValidationException(item);

		expect(error.extensions).toStrictEqual(joiValidationErrorItemToErrorExtensions(item));
		expect(error.message).toBe(item.message);
	});

	it('leaves the type unset for an item that matches no known rule', () => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: '"title" must be a string',
			path: ['title'],
			type: 'string.base',
		});

		expect(extensions).toStrictEqual({ field: 'title' });
		expect('type' in extensions).toBe(false);
	});

	it('leaves the field undefined for a root-level item', () => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: '"value" must contain at least one of [query, keys]',
			path: [],
			type: 'object.missing',
		});

		expect(extensions).toStrictEqual({ field: undefined });
	});
});
