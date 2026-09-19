import { describe, expect, it } from 'vitest';
import { canonicalEncode, compareCodeUnits } from './canonical-encode.js';

function encoded(value: unknown): string {
	return JSON.stringify(canonicalEncode(value));
}

describe('canonicalEncode', () => {
	it('encodes primitives with distinct tags', () => {
		expect(canonicalEncode('x')).toEqual(['s', 'x']);
		expect(canonicalEncode(3)).toEqual(['m', 3]);
		expect(canonicalEncode(true)).toEqual(['b', true]);
		expect(canonicalEncode(null)).toEqual(['n']);
		expect(canonicalEncode(undefined)).toEqual(['u']);
	});

	it('keeps a missing key, an undefined value, and a null value distinct', () => {
		expect(encoded({})).not.toBe(encoded({ a: undefined }));
		expect(encoded({ a: undefined })).not.toBe(encoded({ a: null }));
		expect(encoded({})).not.toBe(encoded({ a: null }));
	});

	it('sorts object keys so key order does not change the encoding', () => {
		expect(encoded({ a: 1, b: 2 })).toBe(encoded({ b: 2, a: 1 }));
	});

	it('orders keys by code unit, not locale collation', () => {
		expect(compareCodeUnits('a', 'b')).toBe(-1);
		expect(compareCodeUnits('b', 'a')).toBe(1);
		expect(compareCodeUnits('a', 'a')).toBe(0);
		expect(compareCodeUnits('Z', 'a')).toBe(-1);
	});

	it('treats composed and decomposed Unicode keys as distinct', () => {
		const composed: Record<string, number> = { [String.fromCharCode(0x00e9)]: 1 };
		const decomposed: Record<string, number> = { [String.fromCharCode(0x65, 0x0301)]: 1 };

		expect(encoded(composed)).not.toBe(encoded(decomposed));
	});

	it('preserves array order', () => {
		expect(encoded(['a', 'b'])).not.toBe(encoded(['b', 'a']));
	});

	it('treats an own __proto__ property as an ordinary entry without polluting the prototype', () => {
		const parsed = JSON.parse('{"__proto__": 1, "a": 2}');

		expect(canonicalEncode(parsed)).toEqual([
			'o',
			[
				['__proto__', ['m', 1]],
				['a', ['m', 2]],
			],
		]);

		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});

	it('encodes a null-prototype object', () => {
		const object = Object.create(null);
		object.a = 1;

		expect(canonicalEncode(object)).toEqual(['o', [['a', ['m', 1]]]]);
	});

	it('recomputes the same encoding for the same input', () => {
		const input = { b: [1, 2], a: { c: null } };

		expect(encoded(input)).toBe(encoded(input));
	});

	it('fails closed on non-finite numbers', () => {
		expect(() => canonicalEncode(Number.NaN)).toThrow(/non-finite/i);
		expect(() => canonicalEncode(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i);
		expect(() => canonicalEncode(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/i);
	});

	it('fails closed on functions, symbols, and bigint', () => {
		expect(() => canonicalEncode(() => undefined)).toThrow(/function/i);
		expect(() => canonicalEncode(Symbol('x'))).toThrow(/symbol/i);
		expect(() => canonicalEncode(1n)).toThrow(/bigint/i);
	});

	it('fails closed on non-plain objects', () => {
		expect(() => canonicalEncode(new Date())).toThrow(/non-plain object/i);
		expect(() => canonicalEncode(new Map())).toThrow(/non-plain object/i);
		expect(() => canonicalEncode(new Set())).toThrow(/non-plain object/i);
		expect(() => canonicalEncode(/re/)).toThrow(/non-plain object/i);

		class Thing {
			value = 1;
		}

		expect(() => canonicalEncode(new Thing())).toThrow(/non-plain object/i);
	});
});
