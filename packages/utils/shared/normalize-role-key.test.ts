import { describe, expect, it } from 'vitest';
import { normalizeRoleKey } from './normalize-role-key.js';

describe('normalizeRoleKey', () => {
	it('converts spaces to underscores and lowercases', () => {
		expect(normalizeRoleKey('Supreme Editor')).toBe('supreme_editor');
	});

	it('strips punctuation', () => {
		expect(normalizeRoleKey('Editor (Legacy)')).toBe('editor_legacy');
	});

	it('strips accents', () => {
		expect(normalizeRoleKey('Café Manager')).toBe('cafe_manager');
	});

	it('strips leading digits', () => {
		expect(normalizeRoleKey('123Admin')).toBe('admin');
	});

	it('passes through already-valid keys', () => {
		expect(normalizeRoleKey('admin')).toBe('admin');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeRoleKey('')).toBe('');
	});

	it('returns empty string for emoji-only input', () => {
		expect(normalizeRoleKey('🎉')).toBe('');
	});

	it('trims and collapses whitespace', () => {
		expect(normalizeRoleKey('  Trim  me  ')).toBe('trim_me');
	});

	it('collapses repeated underscores', () => {
		expect(normalizeRoleKey('a___b')).toBe('a_b');
	});

	it('strips leading underscores', () => {
		expect(normalizeRoleKey('_private')).toBe('private');
	});

	it('handles mixed leading digits and underscores', () => {
		expect(normalizeRoleKey('_2_test')).toBe('test');
	});

	it('is idempotent', () => {
		const inputs = ['Supreme Editor', 'Café Manager', '123Admin', 'editor_legacy', '  Trim  me  '];

		for (const input of inputs) {
			const once = normalizeRoleKey(input);
			const twice = normalizeRoleKey(once);
			expect(twice).toBe(once);
		}
	});
});
