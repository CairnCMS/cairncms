import { describe, expect, it } from 'vitest';
import { stripFunctions } from './strip-functions.js';

describe('stripFunctions', () => {
	it('replaces a top-level function with undefined', () => {
		expect(stripFunctions(() => 1)).toBe(undefined);
	});

	it('strips functions nested in an object', () => {
		const result = stripFunctions({ a: 1, b: () => 2, c: 'x' });
		expect(result).toEqual({ a: 1, b: undefined, c: 'x' });
	});

	it('strips functions nested in an array', () => {
		const result = stripFunctions([1, () => 2, 3]);
		expect(result).toEqual([1, undefined, 3]);
	});

	it('strips functions deep inside nested structures', () => {
		const result = stripFunctions({ outer: { inner: [{ fn: () => 1 }] } });
		expect(result).toEqual({ outer: { inner: [{ fn: undefined }] } });
	});

	it('passes primitives through unchanged', () => {
		expect(stripFunctions(null)).toBe(null);
		expect(stripFunctions(undefined)).toBe(undefined);
		expect(stripFunctions(0)).toBe(0);
		expect(stripFunctions('')).toBe('');
		expect(stripFunctions(false)).toBe(false);
		expect(Number.isNaN(stripFunctions(NaN))).toBe(true);
	});

	it('passes Date, RegExp, Map, Set, Error, ArrayBuffer, TypedArray through unchanged (same reference)', () => {
		const date = new Date();
		const regex = /x/g;
		const map = new Map([['a', 1]]);
		const set = new Set([1, 2]);
		const err = new Error('boom');
		const buf = new ArrayBuffer(4);
		const arr = new Uint8Array([1, 2]);
		expect(stripFunctions(date)).toBe(date);
		expect(stripFunctions(regex)).toBe(regex);
		expect(stripFunctions(map)).toBe(map);
		expect(stripFunctions(set)).toBe(set);
		expect(stripFunctions(err)).toBe(err);
		expect(stripFunctions(buf)).toBe(buf);
		expect(stripFunctions(arr)).toBe(arr);
	});

	it('deep-clones plain objects (output is not the same reference)', () => {
		const input = { a: 1, b: { c: 2 } };
		const output = stripFunctions(input);
		expect(output).not.toBe(input);
		expect(output.b).not.toBe(input.b);
		expect(output).toEqual(input);
	});

	it('deep-clones plain arrays (output is not the same reference)', () => {
		const input = [1, [2, 3]];
		const output = stripFunctions(input);
		expect(output).not.toBe(input);
		expect(output[1]).not.toBe(input[1]);
		expect(output).toEqual(input);
	});

	it('preserves circular references in the output', () => {
		type Cyclic = { name: string; self?: Cyclic };
		const input: Cyclic = { name: 'root' };
		input.self = input;
		const output = stripFunctions(input);
		expect(output.name).toBe('root');
		expect(output.self).toBe(output);
	});

	it('does not mutate the input', () => {
		const fn = () => 1;
		const input = { a: 1, b: fn, c: { d: fn } };
		stripFunctions(input);
		expect(input.b).toBe(fn);
		expect(input.c.d).toBe(fn);
	});
});
