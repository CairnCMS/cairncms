import { describe, it, expect } from 'vitest';
import { checkMatchingConditionalFill } from './conditional-fill';

const baseFormat = { color: 'red' };

describe('panels/pie-chart/checkMatchingConditionalFill', () => {
	describe('numeric column', () => {
		it('Matches exact equality with <= (regression: <= must not be strict <)', () => {
			expect(checkMatchingConditionalFill(100, { ...baseFormat, operator: '<=', value: 100 }, true)).toBe(true);
		});

		it('Matches strictly less than with <=', () => {
			expect(checkMatchingConditionalFill(99, { ...baseFormat, operator: '<=', value: 100 }, true)).toBe(true);
		});

		it('Rejects strictly greater than with <=', () => {
			expect(checkMatchingConditionalFill(101, { ...baseFormat, operator: '<=', value: 100 }, true)).toBe(false);
		});

		it('Matches > strictly', () => {
			expect(checkMatchingConditionalFill(101, { ...baseFormat, operator: '>', value: 100 }, true)).toBe(true);
			expect(checkMatchingConditionalFill(100, { ...baseFormat, operator: '>', value: 100 }, true)).toBe(false);
		});

		it('Matches >= with equality', () => {
			expect(checkMatchingConditionalFill(100, { ...baseFormat, operator: '>=', value: 100 }, true)).toBe(true);
		});

		it('Matches = and !=', () => {
			expect(checkMatchingConditionalFill(50, { ...baseFormat, operator: '=', value: 50 }, true)).toBe(true);
			expect(checkMatchingConditionalFill(50, { ...baseFormat, operator: '!=', value: 50 }, true)).toBe(false);
		});

		it('Returns false when the data value cannot be coerced to a number', () => {
			expect(checkMatchingConditionalFill('not-a-number', { ...baseFormat, operator: '<=', value: 100 }, true)).toBe(
				false
			);
		});
	});

	describe('string column', () => {
		it('Matches contains: data value contains the threshold', () => {
			expect(
				checkMatchingConditionalFill('electronics', { ...baseFormat, operator: 'contains', value: 'elect' }, false)
			).toBe(true);
		});

		it('Rejects contains when the data value does not contain the threshold', () => {
			expect(
				checkMatchingConditionalFill('books', { ...baseFormat, operator: 'contains', value: 'elect' }, false)
			).toBe(false);
		});

		it('Matches ncontains as negated contains', () => {
			expect(
				checkMatchingConditionalFill('books', { ...baseFormat, operator: 'ncontains', value: 'elect' }, false)
			).toBe(true);
			expect(
				checkMatchingConditionalFill('electronics', { ...baseFormat, operator: 'ncontains', value: 'elect' }, false)
			).toBe(false);
		});

		it('Matches starts_with: data value starts with the threshold (regression: switch must handle starts_with)', () => {
			expect(
				checkMatchingConditionalFill('electronics', { ...baseFormat, operator: 'starts_with', value: 'elect' }, false)
			).toBe(true);
		});

		it('Rejects starts_with when the data value does not start with the threshold', () => {
			expect(
				checkMatchingConditionalFill('electronics', { ...baseFormat, operator: 'starts_with', value: 'tron' }, false)
			).toBe(false);
		});

		it('Matches ends_with: data value ends with the threshold (regression: switch must handle ends_with)', () => {
			expect(
				checkMatchingConditionalFill('electronics', { ...baseFormat, operator: 'ends_with', value: 'nics' }, false)
			).toBe(true);
		});

		it('ends_with must reject non-ending matches (regression: ends_with must not behave as ncontains)', () => {
			expect(
				checkMatchingConditionalFill('electronics', { ...baseFormat, operator: 'ends_with', value: 'elect' }, false)
			).toBe(false);
		});

		it('Falls back to false for the default case when an unknown operator slips through', () => {
			expect(
				checkMatchingConditionalFill(
					'foo',
					{ ...baseFormat, operator: 'unknown' as never, value: 'bar' },
					false
				)
			).toBe(false);
		});
	});
});
