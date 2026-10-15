import { set } from 'lodash-es';
import { describe, expect, test } from 'vitest';
import { BUILT_IN_TARGETS, observeBuiltIns } from '../__utils__/built-ins.js';
import { setOwn } from './set-own.js';

describe('setOwn', () => {
	test.each<[string, string | string[]]>([
		['a dotted path', 'a.b.c'],
		['a bracketed index path', 'a[0].b'],
		['a dotted index path', 'a.0.b'],
		['an array path', ['a', 'b']],
		['a quoted bracket key', 'a["b.c"].d'],
	])('matches lodash set for %s', (_label, path) => {
		expect(setOwn({}, path, 1)).toStrictEqual(set({}, path, 1));
	});

	test('treats an existing literal dotted key as one key, as lodash set does', () => {
		expect(setOwn({ 'a.b': 0 }, 'a.b', 1)).toStrictEqual(set({ 'a.b': 0 }, 'a.b', 1));
	});

	test.each(['a.__proto__.x', 'constructor.x', 'a.prototype.b'])(
		'handles the refused segment in %s as lodash set does',
		(path) => {
			expect(setOwn({}, path, 1)).toStrictEqual(set({}, path, 1));
		}
	);

	test.each<[string, Record<string, unknown>, string, unknown]>([
		['toString.call', {}, 'toString.call', { toString: { call: 1 } }],
		['valueOf.call', {}, 'valueOf.call', { valueOf: { call: 1 } }],
		['a.toString.call', {}, 'a.toString.call', { a: { toString: { call: 1 } } }],
		['hasOwnProperty.x', {}, 'hasOwnProperty.x', { hasOwnProperty: { x: 1 } }],
	])('writes %s as own data without changing built-ins', async (_label, target, path, expected) => {
		const { result, changes } = await observeBuiltIns(BUILT_IN_TARGETS, () => setOwn(target, path, 1));

		expect(changes).toEqual([]);
		expect(result).toStrictEqual(expected);
	});

	test('writes through an inherited array method as own data without changing built-ins', async () => {
		const target: { list: unknown[][] } = { list: [[]] };

		const { changes } = await observeBuiltIns(BUILT_IN_TARGETS, () => setOwn(target, 'list.0.map.x', 1));

		expect(changes).toEqual([]);
		expect(Array.isArray(target.list[0])).toBe(true);
		expect(Object.hasOwn(target.list[0]!, 'map')).toBe(true);
		expect((target.list[0] as unknown as { map: unknown }).map).toStrictEqual({ x: 1 });
	});

	test('creates a plain object for an index after an inherited name', async () => {
		const { result, changes } = await observeBuiltIns(BUILT_IN_TARGETS, () => setOwn({}, 'toString.0', 1));

		expect(changes).toEqual([]);
		expect(result).toStrictEqual({ toString: { 0: 1 } });
	});

	test('reuses an existing own object', () => {
		const own = { keep: true };
		const target = { a: own };

		setOwn(target, 'a.b', 1);

		expect(target.a).toBe(own);
		expect(own).toStrictEqual({ keep: true, b: 1 });
	});
});
