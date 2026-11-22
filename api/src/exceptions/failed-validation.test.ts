import { FailedValidationException } from '@cairncms/exceptions';
import type { Filter } from '@cairncms/types';
import { parseFilter, validatePayload } from '@cairncms/utils';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { validateBatch } from '../middleware/validate-batch.js';

const OPERAND = 'OPERAND_MARKER';
const SUBMITTED = 'SUBMITTED_MARKER';

function convert(filter: Record<string, unknown>, payload: Record<string, unknown>): FailedValidationException {
	const item = validatePayload(filter as Filter, payload)[0]!.details[0]!;
	return new FailedValidationException(item);
}

async function convertBatch(body: Record<string, unknown>): Promise<FailedValidationException> {
	const next = vi.fn();
	await validateBatch('delete')({ method: 'DELETE', body } as Request, {} as Response, next);
	return next.mock.calls[0]![0];
}

function expectNoMarker(error: FailedValidationException) {
	const serialized = JSON.stringify({ message: error.message, extensions: error.extensions });

	expect(serialized).not.toContain(OPERAND);
	expect(serialized).not.toContain(SUBMITTED);
}

const field = (sentence: string) => `Validation failed for field "f". ${sentence}`;

const cases: [string, Record<string, unknown>, Record<string, unknown>, string, Record<string, unknown>][] = [
	[
		'_eq',
		{ f: { _eq: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to be the required value.'),
		{ field: 'f', type: 'eq' },
	],
	[
		'numeric _eq',
		{ f: { _eq: '42' } },
		{ f: 'x' },
		field('Value has to be the required value.'),
		{ field: 'f', type: 'eq' },
	],
	[
		'_in',
		{ f: { _in: [OPERAND, 'b'] } },
		{ f: SUBMITTED },
		field('Value has to be one of the allowed values.'),
		{ field: 'f', type: 'in' },
	],
	[
		'empty _in',
		{ f: { _in: [] } },
		{ f: SUBMITTED },
		field('Value has to be one of the allowed values.'),
		{ field: 'f', type: 'in' },
	],
	['_null', { f: { _null: true } }, { f: SUBMITTED }, field('Value has to be null.'), { field: 'f', type: 'null' }],
	['_empty', { f: { _empty: true } }, { f: SUBMITTED }, field('Value has to be empty.'), { field: 'f', type: 'empty' }],
	[
		'_neq',
		{ f: { _neq: OPERAND } },
		{ f: OPERAND },
		field(`Value can't be the excluded value.`),
		{ field: 'f', type: 'neq' },
	],
	[
		'_nin',
		{ f: { _nin: [SUBMITTED, OPERAND] } },
		{ f: SUBMITTED },
		field(`Value can't be one of the excluded values.`),
		{ field: 'f', type: 'nin' },
	],
	['_nnull', { f: { _nnull: true } }, { f: null }, field(`Value can't be null.`), { field: 'f', type: 'nnull' }],
	['_nempty', { f: { _nempty: true } }, { f: '' }, field(`Value can't be empty.`), { field: 'f', type: 'nempty' }],
	[
		'_gt',
		{ f: { _gt: 100 } },
		{ f: 5 },
		field('Value has to be greater than the minimum.'),
		{ field: 'f', type: 'gt' },
	],
	[
		'_gte',
		{ f: { _gte: 100 } },
		{ f: 5 },
		field('Value has to be greater than or equal to the minimum.'),
		{ field: 'f', type: 'gte' },
	],
	['_lt', { f: { _lt: 1 } }, { f: 5 }, field('Value has to be less than the maximum.'), { field: 'f', type: 'lt' }],
	[
		'_lte',
		{ f: { _lte: 1 } },
		{ f: 5 },
		field('Value has to be less than or equal to the maximum.'),
		{ field: 'f', type: 'lte' },
	],
	[
		'_contains',
		{ f: { _contains: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to contain the required text.'),
		{ field: 'f', type: 'contains' },
	],
	[
		'_icontains',
		{ f: { _icontains: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to contain the required text.'),
		{ field: 'f', type: 'contains' },
	],
	[
		'_ncontains',
		{ f: { _ncontains: OPERAND } },
		{ f: `${SUBMITTED}${OPERAND}` },
		field(`Value can't contain the excluded text.`),
		{ field: 'f', type: 'ncontains' },
	],
	['_submitted', { f: { _submitted: true } }, {}, field('Value is required.'), { field: 'f', type: 'required' }],
	[
		'_regex',
		{ f: { _regex: OPERAND } },
		{ f: SUBMITTED },
		field(`Value doesn't have the correct format.`),
		{ field: 'f', type: 'regex' },
	],
	[
		'_starts_with',
		{ f: { _starts_with: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to start with the required text.'),
		{ field: 'f', type: 'starts_with' },
	],
	[
		'_ends_with',
		{ f: { _ends_with: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to end with the required text.'),
		{ field: 'f', type: 'ends_with' },
	],
	[
		'_nstarts_with',
		{ f: { _nstarts_with: OPERAND } },
		{ f: `${OPERAND}${SUBMITTED}` },
		field(`Value can't start with the excluded text.`),
		{ field: 'f', type: 'nstarts_with' },
	],
	[
		'_nends_with',
		{ f: { _nends_with: OPERAND } },
		{ f: `${SUBMITTED}${OPERAND}` },
		field(`Value can't end with the excluded text.`),
		{ field: 'f', type: 'nends_with' },
	],
	[
		'_istarts_with',
		{ f: { _istarts_with: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to start with the required text.'),
		{ field: 'f', type: 'istarts_with' },
	],
	[
		'_nistarts_with',
		{ f: { _nistarts_with: OPERAND } },
		{ f: `${OPERAND.toLowerCase()}${SUBMITTED}` },
		field(`Value can't start with the excluded text.`),
		{ field: 'f', type: 'nistarts_with' },
	],
	[
		'_iends_with',
		{ f: { _iends_with: OPERAND } },
		{ f: SUBMITTED },
		field('Value has to end with the required text.'),
		{ field: 'f', type: 'iends_with' },
	],
	[
		'_niends_with',
		{ f: { _niends_with: OPERAND } },
		{ f: `${SUBMITTED}${OPERAND.toLowerCase()}` },
		field(`Value can't end with the excluded text.`),
		{ field: 'f', type: 'niends_with' },
	],
	[
		'_starts_with on a number',
		{ f: { _starts_with: OPERAND } },
		{ f: 42 },
		field('Value has to start with the required text.'),
		{ field: 'f', type: 'starts_with' },
	],
	['_between', { f: { _between: [10, 20] } }, { f: 5 }, 'Validation failed for field "f".', { field: 'f' }],
	['_nbetween', { f: { _nbetween: [20, 10] } }, { f: 25 }, 'Validation failed for field "f".', { field: 'f' }],
];

function convertDynamic(rule: string, operand: unknown, payload: Record<string, unknown>) {
	const context = { $CURRENT_USER: { tenant: { value: operand } } } as any;
	const filter = parseFilter({ f: { [rule]: '$CURRENT_USER.tenant.value' } } as Filter, null, context);

	return validatePayload(filter!, payload).flatMap((error) =>
		error.details.map((item) => {
			const exception = new FailedValidationException(item);
			return { message: exception.message, extensions: exception.extensions };
		})
	);
}

const TEXT_OPERANDS = ['abc', null, 42, ''];
const TEXT_SUBMISSIONS = ['zzz', 'abc', 42, true];
const COMPARISON_OPERANDS = [5, '7', '2026-01-01', '2000-01-01', null];
const COMPARISON_SUBMISSIONS = [7, '2020-01-01', 'zzz', 1e300];

const RANGE_OPERANDS = [
	[10, 20],
	[0, 5],
	[10, 5],
	['2026-01-01', '2027-01-01'],
	['2000-01-01', '2001-01-01'],
];

const RANGE_SUBMISSIONS = [7, '2020-01-01', 'zzz'];

describe('FailedValidationException conversion', () => {
	it.each(cases)(
		'converts a failed %s rule without its operand or the submitted value',
		(_rule, filter, payload, message, extensions) => {
			const error = convert(filter, payload);

			expect(error.message).toBe(message);
			expect(error.extensions).toStrictEqual(extensions);
			expectNoMarker(error);
		}
	);

	it.each([
		['_eq', [OPERAND, '4821', null, '', true], (operand: unknown) => ({ _eq: operand }), () => SUBMITTED, 'eq'],
		[
			'_neq',
			[OPERAND, '4821', null, '', true],
			(operand: unknown) => ({ _neq: operand }),
			(operand: unknown) => operand,
			'neq',
		],
		[
			'_in',
			[[OPERAND], [OPERAND, 'b'], [null], [''], ['4821'], []],
			(operand: unknown) => ({ _in: operand }),
			() => SUBMITTED,
			'in',
		],
		[
			'_nin',
			[[OPERAND], [OPERAND, 'b'], [null], [''], ['4821']],
			(operand: unknown) => ({ _nin: operand }),
			(operand: unknown) => (operand as unknown[])[0],
			'nin',
		],
	])('reports a failed %s rule the same way whatever its operand', (_rule, operands, rule, submitted, type) => {
		for (const operand of operands) {
			const error = convert({ f: rule(operand) }, { f: submitted(operand) });

			const sentence = {
				eq: 'Value has to be the required value.',
				neq: `Value can't be the excluded value.`,
				in: 'Value has to be one of the allowed values.',
				nin: `Value can't be one of the excluded values.`,
			}[type];

			expect(error.message, JSON.stringify(operand)).toBe(field(sentence!));
			expect(error.extensions, JSON.stringify(operand)).toStrictEqual({ field: 'f', type });
		}
	});

	it.each([OPERAND, '4821', null, ''])(
		'reports a failed dynamic _eq rule as eq when the current user value is %j',
		(secret) => {
			const context = { $CURRENT_USER: { tenant: { secret_code: secret } } } as any;
			const filter = parseFilter({ code: { _eq: '$CURRENT_USER.tenant.secret_code' } } as Filter, null, context);

			const item = validatePayload(filter!, { code: SUBMITTED })[0]!.details[0]!;
			const error = new FailedValidationException(item);

			expect(error.message).toBe('Validation failed for field "code". Value has to be the required value.');
			expect(error.extensions).toStrictEqual({ field: 'code', type: 'eq' });
		}
	);

	it.each([
		['_contains', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'contains', 'Value has to contain the required text.'],
		['_icontains', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'contains', 'Value has to contain the required text.'],
		['_ncontains', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'ncontains', `Value can't contain the excluded text.`],
		['_starts_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'starts_with', 'Value has to start with the required text.'],
		['_nstarts_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'nstarts_with', `Value can't start with the excluded text.`],
		['_ends_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'ends_with', 'Value has to end with the required text.'],
		['_nends_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'nends_with', `Value can't end with the excluded text.`],
		['_istarts_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'istarts_with', 'Value has to start with the required text.'],
		['_nistarts_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'nistarts_with', `Value can't start with the excluded text.`],
		['_iends_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'iends_with', 'Value has to end with the required text.'],
		['_niends_with', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'niends_with', `Value can't end with the excluded text.`],
		['_regex', TEXT_OPERANDS, TEXT_SUBMISSIONS, 'regex', `Value doesn't have the correct format.`],
		['_gt', COMPARISON_OPERANDS, COMPARISON_SUBMISSIONS, 'gt', 'Value has to be greater than the minimum.'],
		[
			'_gte',
			COMPARISON_OPERANDS,
			COMPARISON_SUBMISSIONS,
			'gte',
			'Value has to be greater than or equal to the minimum.',
		],
		['_lt', COMPARISON_OPERANDS, COMPARISON_SUBMISSIONS, 'lt', 'Value has to be less than the maximum.'],
		['_lte', COMPARISON_OPERANDS, COMPARISON_SUBMISSIONS, 'lte', 'Value has to be less than or equal to the maximum.'],
		['_between', RANGE_OPERANDS, RANGE_SUBMISSIONS, undefined, undefined],
		['_nbetween', RANGE_OPERANDS, RANGE_SUBMISSIONS, undefined, undefined],
	])(
		'reports every rejection of a dynamic %s rule the same way whatever its operand',
		(rule, operands, submissions, type, sentence) => {
			const expected = {
				message: sentence ? field(sentence) : 'Validation failed for field "f".',
				extensions: type ? { field: 'f', type } : { field: 'f' },
			};

			let rejections = 0;

			for (const submitted of submissions) {
				for (const operand of operands) {
					for (const diagnostic of convertDynamic(rule, operand, { f: submitted })) {
						expect(diagnostic, JSON.stringify({ operand, submitted })).toStrictEqual(expected);
						rejections++;
					}
				}
			}

			expect(rejections).toBeGreaterThan(operands.length);
		}
	);

	it.each([
		['_contains', 'abc', 'abcd'],
		['_starts_with', '', 'zzz'],
		['_istarts_with', 'ABC', 'abcd'],
		['_niends_with', 'abc', 'abcd'],
		['_gt', 5, 7],
		['_between', [0, 10], 7],
	])('keeps a dynamic %s rule that the value satisfies passing', (rule, operand, submitted) => {
		expect(convertDynamic(rule, operand, { f: submitted })).toEqual([]);
	});

	it('converts the password-policy item without the password', () => {
		const error = new FailedValidationException({
			message: `Provided password doesn't match password policy`,
			path: ['password'],
			type: 'custom.pattern.base',
			context: { value: SUBMITTED },
		});

		expect(error.message).toBe(`Validation failed for field "password". Value doesn't have the correct format.`);
		expect(error.extensions).toStrictEqual({ field: 'password', type: 'regex' });
		expectNoMarker(error);
	});

	it('converts a batch body with neither keys nor a query', async () => {
		const error = await convertBatch({});

		expect(error).toBeInstanceOf(FailedValidationException);
		expect(error.message).toBe('Validation failed.');
		expect(error.extensions).toStrictEqual({ field: undefined });
	});

	it('converts a batch body with a key that is not a string or number', async () => {
		const error = await convertBatch({ keys: [{ id: SUBMITTED }] });

		expect(error).toBeInstanceOf(FailedValidationException);
		expect(error.message).toBe('Validation failed for field "keys".');
		expect(error.extensions).toStrictEqual({ field: 'keys' });
		expectNoMarker(error);
	});
});
