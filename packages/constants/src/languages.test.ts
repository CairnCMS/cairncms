import { describe, expect, it } from 'vitest';
import { AVAILABLE_LANGUAGES, isAvailableLanguage } from './languages.js';

const codes = Object.keys(AVAILABLE_LANGUAGES);

// Config snapshots use locale codes as filename stems.
const FILENAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STEM_MAX_LENGTH = 246;

describe('AVAILABLE_LANGUAGES catalogue', () => {
	it('has at least one locale', () => {
		expect(codes.length).toBeGreaterThan(0);
	});

	it('maps every code to a non-empty label', () => {
		for (const code of codes) {
			expect(typeof AVAILABLE_LANGUAGES[code]).toBe('string');
			expect(AVAILABLE_LANGUAGES[code]).not.toBe('');
		}
	});

	it('exposes only filename-safe, bounded codes', () => {
		for (const code of codes) {
			expect(FILENAME_SAFE.test(code)).toBe(true);
			expect(code.length).toBeLessThanOrEqual(STEM_MAX_LENGTH);
		}
	});

	it('has case-insensitively unique codes', () => {
		const lowered = codes.map((code) => code.toLowerCase());
		expect(new Set(lowered).size).toBe(codes.length);
	});
});

describe('isAvailableLanguage', () => {
	it('accepts an exact catalogue code', () => {
		expect(isAvailableLanguage('fr-FR')).toBe(true);
		expect(isAvailableLanguage('es-419')).toBe(true);
		expect(isAvailableLanguage('zh-TW')).toBe(true);
	});

	it('rejects a case variant of a catalogue code', () => {
		expect(isAvailableLanguage('fr-fr')).toBe(false);
		expect(isAvailableLanguage('FR-FR')).toBe(false);
	});

	it('rejects a code that is not in the catalogue', () => {
		expect(isAvailableLanguage('made-up')).toBe(false);
		expect(isAvailableLanguage('')).toBe(false);
	});

	it('rejects inherited object properties named like keys', () => {
		expect(isAvailableLanguage('__proto__')).toBe(false);
		expect(isAvailableLanguage('toString')).toBe(false);
		expect(isAvailableLanguage('constructor')).toBe(false);
	});
});
