import { describe, expect, it } from 'vitest';
import { getBetweenParens } from './get-between-parens.js';

const previousPattern = /\(([^)]+)\)/;

function previousResult(value: string) {
	return value.match(previousPattern)?.[1] ?? null;
}

function* everyString(alphabet: string[], maxLength: number): Generator<string> {
	let current = [''];

	for (let length = 0; length <= maxLength; length++) {
		yield* current;
		current = current.flatMap((prefix) => alphabet.map((character) => prefix + character));
	}
}

describe('getBetweenParens', () => {
	it.each([
		['year(date_created)', 'date_created'],
		['count(a.b.field)', 'a.b.field'],
		['$NOW(-1 day)', '-1 day'],
		['f(  x  )', '  x  '],
		['x(y)z(w)', 'y'],
		['((x)', '(x'],
		['()(x)', 'x'],
		['(a(b)c)', 'a(b'],
		['(()', '('],
	])('returns the enclosed text of %s', (value, expected) => {
		expect(getBetweenParens(value)).toBe(expected);
	});

	it.each(['', 'field', '()', 'a)(b', ')(', '(', ')', 'a(b'])('returns null for %j', (value) => {
		expect(getBetweenParens(value)).toBeNull();
	});

	it('matches the previous pattern for every short string of parentheses and text', () => {
		for (const value of everyString(['(', ')', 'a'], 9)) {
			expect(getBetweenParens(value), value).toBe(previousResult(value));
		}
	});

	it('returns null for long unbalanced input', () => {
		expect(getBetweenParens(')' + '('.repeat(100_000))).toBeNull();
		expect(getBetweenParens('a)' + '(a'.repeat(50_000))).toBeNull();
	});
});
