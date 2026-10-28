import { describe, expect, test } from 'vitest';
import { parseRequestTarget } from './parse-request-target.js';

describe('parseRequestTarget', () => {
	test('returns the parsed result for an ordinary target', () => {
		expect(parseRequestTarget('/items/books?limit=1')?.pathname).toBe('/items/books');
	});

	test('parses a protocol-relative target the legacy parser accepts', () => {
		expect(parseRequestTarget('//[x/items')?.pathname).toBe('//[x/items');
	});

	test('returns null for an absolute-form target with an invalid host', () => {
		expect(parseRequestTarget('http://[/items/books')).toBeNull();
	});

	test('returns null for a target carrying credentials before an invalid host', () => {
		expect(parseRequestTarget('//alice:secret@[x/items')).toBeNull();
	});
});
