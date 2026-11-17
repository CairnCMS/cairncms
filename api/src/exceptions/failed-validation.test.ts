import { FailedValidationException } from '@cairncms/exceptions';
import type { Filter } from '@cairncms/types';
import { validatePayload } from '@cairncms/utils';
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

const cases: [string, Record<string, unknown>, Record<string, unknown>, string, Record<string, unknown>][] = [
	[
		'_eq',
		{ f: { _eq: OPERAND } },
		{ f: SUBMITTED },
		'"f" must be [OPERAND_MARKER]',
		{ field: 'f', type: 'eq', valid: OPERAND },
	],
	[
		'numeric _eq',
		{ f: { _eq: '42' } },
		{ f: 'x' },
		'"f" must be one of [42, 42]',
		{ field: 'f', type: 'in', valid: ['42', 42] },
	],
	[
		'_in',
		{ f: { _in: [OPERAND, 'b'] } },
		{ f: SUBMITTED },
		'"f" must be one of [OPERAND_MARKER, b]',
		{ field: 'f', type: 'in', valid: [OPERAND, 'b'] },
	],
	['_null', { f: { _null: true } }, { f: SUBMITTED }, '"f" must be [null]', { field: 'f', type: 'null' }],
	['_empty', { f: { _empty: true } }, { f: SUBMITTED }, '"f" must be []', { field: 'f', type: 'empty' }],
	[
		'_neq',
		{ f: { _neq: OPERAND } },
		{ f: OPERAND },
		'"f" contains an invalid value',
		{ field: 'f', type: 'neq', invalid: OPERAND },
	],
	[
		'_nin',
		{ f: { _nin: [SUBMITTED, OPERAND] } },
		{ f: SUBMITTED },
		'"f" contains an invalid value',
		{ field: 'f', type: 'nin', invalid: [SUBMITTED, OPERAND] },
	],
	['_nnull', { f: { _nnull: true } }, { f: null }, '"f" contains an invalid value', { field: 'f', type: 'nnull' }],
	['_nempty', { f: { _nempty: true } }, { f: '' }, '"f" contains an invalid value', { field: 'f', type: 'nempty' }],
	['_gt', { f: { _gt: 100 } }, { f: 5 }, '"f" must be greater than 100', { field: 'f', type: 'gt', valid: 100 }],
	[
		'_gte',
		{ f: { _gte: 100 } },
		{ f: 5 },
		'"f" must be greater than or equal to 100',
		{ field: 'f', type: 'gte', valid: 100 },
	],
	['_lt', { f: { _lt: 1 } }, { f: 5 }, '"f" must be less than 1', { field: 'f', type: 'lt', valid: 1 }],
	['_lte', { f: { _lte: 1 } }, { f: 5 }, '"f" must be less than or equal to 1', { field: 'f', type: 'lte', valid: 1 }],
	[
		'_contains',
		{ f: { _contains: OPERAND } },
		{ f: SUBMITTED },
		'"f" must contain [OPERAND_MARKER]',
		{ field: 'f', type: 'contains', substring: OPERAND },
	],
	[
		'_icontains',
		{ f: { _icontains: OPERAND } },
		{ f: SUBMITTED },
		'"f" must contain [OPERAND_MARKER]',
		{ field: 'f', type: 'contains', substring: OPERAND },
	],
	[
		'_ncontains',
		{ f: { _ncontains: OPERAND } },
		{ f: `${SUBMITTED}${OPERAND}` },
		`"f" can't contain [OPERAND_MARKER]`,
		{ field: 'f', type: 'ncontains', substring: OPERAND },
	],
	['_submitted', { f: { _submitted: true } }, {}, '"f" is required', { field: 'f', type: 'required' }],
	[
		'_regex',
		{ f: { _regex: OPERAND } },
		{ f: SUBMITTED },
		'"f" with value "SUBMITTED_MARKER" fails to match the required pattern: /OPERAND_MARKER/',
		{ field: 'f', type: 'regex', invalid: SUBMITTED },
	],
	[
		'_starts_with',
		{ f: { _starts_with: OPERAND } },
		{ f: SUBMITTED },
		'"f" with value "SUBMITTED_MARKER" fails to match the starts_with pattern',
		{ field: 'f' },
	],
	[
		'_ends_with',
		{ f: { _ends_with: OPERAND } },
		{ f: SUBMITTED },
		'"f" with value "SUBMITTED_MARKER" fails to match the ends_with pattern',
		{ field: 'f' },
	],
	[
		'_nstarts_with',
		{ f: { _nstarts_with: OPERAND } },
		{ f: `${OPERAND}${SUBMITTED}` },
		'"f" with value "OPERAND_MARKERSUBMITTED_MARKER" matches the inverted starts_with pattern',
		{ field: 'f' },
	],
	[
		'_nends_with',
		{ f: { _nends_with: OPERAND } },
		{ f: `${SUBMITTED}${OPERAND}` },
		'"f" with value "SUBMITTED_MARKEROPERAND_MARKER" matches the inverted ends_with pattern',
		{ field: 'f' },
	],
	['_starts_with on a number', { f: { _starts_with: OPERAND } }, { f: 42 }, '"f" must be a string', { field: 'f' }],
];

describe('FailedValidationException conversion', () => {
	it.each(cases)('converts a failed %s rule', (_rule, filter, payload, message, extensions) => {
		const error = convert(filter, payload);

		expect(error.message).toBe(message);
		expect(error.extensions).toStrictEqual(extensions);
	});

	it('converts a failed empty _in rule to eq with an internal symbol', () => {
		const error = convert({ f: { _in: [] } }, { f: SUBMITTED });

		expect(error.message).toBe('"f" must be [Symbol(cairncms-empty-in)]');
		expect(error.extensions.type).toBe('eq');
		expect(typeof error.extensions.valid).toBe('symbol');
	});

	it('converts the password-policy item', () => {
		const error = new FailedValidationException({
			message: `Provided password doesn't match password policy`,
			path: ['password'],
			type: 'custom.pattern.base',
			context: { value: SUBMITTED },
		});

		expect(error.message).toBe(`Provided password doesn't match password policy`);
		expect(error.extensions).toStrictEqual({ field: 'password', type: 'regex', invalid: SUBMITTED });
	});

	it('converts a batch body with neither keys nor a query', async () => {
		const error = await convertBatch({});

		expect(error).toBeInstanceOf(FailedValidationException);
		expect(error.message).toBe('"value" must contain at least one of [query, keys]');
		expect(error.extensions).toStrictEqual({ field: undefined });
	});

	it('converts a batch body with a key that is not a string or number', async () => {
		const error = await convertBatch({ keys: [{ id: SUBMITTED }] });

		expect(error).toBeInstanceOf(FailedValidationException);
		expect(error.message).toBe('"keys[0]" must be one of [string, number]');
		expect(error.extensions).toStrictEqual({ field: 'keys' });
	});
});
