import { describe, expect, it } from 'vitest';
import { FailedValidationException } from './failed-validation.js';
import { joiValidationErrorItemToErrorExtensions, type ValidationErrorItem } from './joi-to-error-extensions.js';

const items: ValidationErrorItem[] = [
	{
		message: '"title" must be [a]',
		path: ['title'],
		type: 'any.only',
		context: { valids: ['a'], value: 'b', validationOperator: '_eq' },
	},
	{
		message: '"title" contains an invalid value',
		path: ['title'],
		type: 'any.invalid',
		context: { invalids: [null], validationOperator: '_nnull' },
	},
	{ message: '"title" is required', path: ['title'], type: 'any.required', context: {} },
	{ message: '"title" must be a string', path: ['title'], type: 'string.base', context: { value: 42 } },
];

describe('joiValidationErrorItemToErrorExtensions', () => {
	it.each(items)('gives the same details as FailedValidationException for $type', (item) => {
		const error = new FailedValidationException(item);

		expect(error.extensions).toStrictEqual(joiValidationErrorItemToErrorExtensions(item));
	});

	it.each([
		[
			{
				message: '"title" must be [a]',
				path: ['title'],
				type: 'any.only',
				context: { valids: ['a'], validationOperator: '_eq' },
			},
			'Validation failed for field "title". Value has to be the required value.',
		],
		[
			{ message: '"title" must be a string', path: ['title'], type: 'string.base' },
			'Validation failed for field "title".',
		],
		[{ message: '"value" is required', path: [], type: 'any.required' }, 'Validation failed. Value is required.'],
	])('builds a fixed message from the field and the rule type, not from the Joi message', (item, message) => {
		expect(new FailedValidationException(item as ValidationErrorItem).message).toBe(message);
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

	it.each([
		['string.pattern.name', 'starts_with'],
		['string.pattern.invert.name', 'nstarts_with'],
		['string.pattern.name', 'ends_with'],
		['string.pattern.invert.name', 'nends_with'],
	])('takes the type of a %s item from its allowed name %s, without the operand', (type, name) => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: `"title" with value "x" fails to match the ${name} pattern`,
			path: ['title'],
			type,
			context: { name, regex: /^secret.*/, value: 'x' },
		});

		expect(extensions).toStrictEqual({ field: 'title', type: name });
	});

	it('leaves a pattern item with an unknown name unclassified', () => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: '"title" with value "x" fails to match the custom_rule pattern',
			path: ['title'],
			type: 'string.pattern.name',
			context: { name: 'custom_rule', regex: /^secret.*/, value: 'x' },
		});

		expect(extensions).toStrictEqual({ field: 'title' });
	});

	const unreadable = () => {
		throw new Error('the compared values were read');
	};

	it.each([
		['any.only', '_eq', 'eq'],
		['any.only', '_in', 'in'],
		['any.only', '_null', 'null'],
		['any.only', '_empty', 'empty'],
		['any.invalid', '_neq', 'neq'],
		['any.invalid', '_nin', 'nin'],
		['any.invalid', '_nnull', 'nnull'],
		['any.invalid', '_nempty', 'nempty'],
	])('takes the type of a %s item from its %s operator without reading the compared values', (type, operator, rule) => {
		const context = { validationOperator: operator };
		Object.defineProperty(context, 'valids', { get: unreadable });
		Object.defineProperty(context, 'invalids', { get: unreadable });

		const extensions = joiValidationErrorItemToErrorExtensions({ message: 'm', path: ['title'], type, context });

		expect(extensions).toStrictEqual({ field: 'title', type: rule });
	});

	it.each([
		['any.only', undefined],
		['any.invalid', undefined],
		['any.only', '_neq'],
		['any.invalid', '_eq'],
		['any.only', '_gt'],
		['any.only', 'eq'],
		['any.only', 'constructor'],
		['any.invalid', '__proto__'],
		['any.only', 42],
	])('leaves a %s item with operator %s unclassified', (type, operator) => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: 'm',
			path: ['title'],
			type,
			context: { valids: [null], invalids: [''], validationOperator: operator },
		});

		expect(extensions).toStrictEqual({ field: 'title' });
	});

	it('reports a required item as required whatever operator its schema recorded', () => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: '"title" is required',
			path: ['title'],
			type: 'any.required',
			context: { validationOperator: '_eq' },
		});

		expect(extensions).toStrictEqual({ field: 'title', type: 'required' });
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
