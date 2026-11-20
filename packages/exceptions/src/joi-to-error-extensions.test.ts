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

	it.each(['_eq', '_contains', '_gt', '_between'])(
		'reports a required item as required when its schema recorded %s',
		(operator) => {
			const extensions = joiValidationErrorItemToErrorExtensions({
				message: '"title" is required',
				path: ['title'],
				type: 'any.required',
				context: { validationOperator: operator },
			});

			expect(extensions).toStrictEqual({ field: 'title', type: 'required' });
		}
	);

	const unreadableContext = (operator: string) => {
		const context = { validationOperator: operator };

		for (const key of ['valids', 'invalids', 'value', 'limit', 'substring', 'regex', 'name']) {
			Object.defineProperty(context, key, { get: unreadable });
		}

		return context;
	};

	it.each([
		['string.contains', '_contains', 'contains'],
		['any.only', '_contains', 'contains'],
		['string.base', '_icontains', 'contains'],
		['string.ncontains', '_ncontains', 'ncontains'],
		['any.only', '_ncontains', 'ncontains'],
		['string.pattern.name', '_starts_with', 'starts_with'],
		['string.base', '_starts_with', 'starts_with'],
		['any.only', '_nstarts_with', 'nstarts_with'],
		['string.pattern.name', '_ends_with', 'ends_with'],
		['string.pattern.invert.name', '_nends_with', 'nends_with'],
		['string.pattern.base', '_regex', 'regex'],
		['any.only', '_regex', 'regex'],
		['number.greater', '_gt', 'gt'],
		['date.greater', '_gt', 'gt'],
		['number.base', '_gt', 'gt'],
		['any.only', '_gt', 'gt'],
		['date.base', '_gte', 'gte'],
		['number.unsafe', '_lt', 'lt'],
		['date.max', '_lte', 'lte'],
	])(
		'takes the type of a %s item from its authored %s rule without reading the compared values',
		(type, operator, rule) => {
			const extensions = joiValidationErrorItemToErrorExtensions({
				message: 'm',
				path: ['title'],
				type,
				context: unreadableContext(operator),
			});

			expect(extensions).toStrictEqual({ field: 'title', type: rule });
		}
	);

	it.each([
		['number.min', '_between'],
		['number.max', '_between'],
		['date.min', '_between'],
		['number.base', '_between'],
		['number.less', '_nbetween'],
		['date.greater', '_nbetween'],
	])('leaves a %s item from a %s range unclassified', (type, operator) => {
		const item = { message: 'm', path: ['title'], type, context: unreadableContext(operator) };

		expect(joiValidationErrorItemToErrorExtensions(item)).toStrictEqual({ field: 'title' });
		expect(new FailedValidationException(item).message).toBe('Validation failed for field "title".');
	});

	it.each([
		['number.greater', undefined, 'gt'],
		['number.min', undefined, 'gte'],
		['string.pattern.base', undefined, 'regex'],
		['number.greater', 'constructor', 'gt'],
	])('classifies a %s item with operator %s by its Joi type', (type, operator, rule) => {
		const extensions = joiValidationErrorItemToErrorExtensions({
			message: 'm',
			path: ['title'],
			type,
			context: { validationOperator: operator },
		});

		expect(extensions).toStrictEqual({ field: 'title', type: rule });
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
