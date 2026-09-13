import { normalizeConfigKey } from '@cairncms/utils';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../config-contract.js';
import { generateBoundedKey } from './generate-bounded-key.js';

const MAX = CONFIG_FILENAME_STEM_MAX_LENGTH;

describe('generateBoundedKey', () => {
	it('returns the normalized name unchanged for an ordinary short name', () => {
		expect(generateBoundedKey('Editor', new Set(), { fallback: 'role' })).toBe('editor');
	});

	it('falls back when the name normalizes to empty', () => {
		expect(generateBoundedKey('   ', new Set(), { fallback: 'folder' })).toBe('folder');
	});

	it('deduplicates against used keys and reserved keys with a numeric suffix', () => {
		const key = generateBoundedKey('Editor', new Set(['editor']), {
			fallback: 'role',
			reserved: new Set(['editor_2']),
		});

		expect(key).toBe('editor_3');
	});

	it('adds each generated key to the used set', () => {
		const used = new Set<string>();
		generateBoundedKey('Editor', used, { fallback: 'role' });

		expect(used.has('editor')).toBe(true);
	});

	it('truncates an overlong name to the bound with no suffix', () => {
		expect(generateBoundedKey('a'.repeat(MAX + 4), new Set(), { fallback: 'role' })).toBe('a'.repeat(MAX));
	});

	it('reserves suffix room so truncated collisions stay bounded and grow to two digits', () => {
		const used = new Set<string>();
		const name = 'a'.repeat(MAX + 4);
		const keys = Array.from({ length: 10 }, () => generateBoundedKey(name, used, { fallback: 'role' }));

		expect(keys[0]).toBe('a'.repeat(MAX));
		expect(keys[8]).toBe('a'.repeat(MAX - 2) + '_9');
		expect(keys[9]).toBe('a'.repeat(MAX - 3) + '_10');
		expect(new Set(keys).size).toBe(10);
		expect(keys.every((key) => key.length <= MAX)).toBe(true);
	});

	it('strips a trailing underscore at the truncation junction so no double underscore forms', () => {
		const candidate = 'a'.repeat(MAX - 3) + '_' + 'b'.repeat(10);
		const key = generateBoundedKey(candidate, new Set([candidate.slice(0, MAX)]), { fallback: 'role' });

		expect(key).toBe('a'.repeat(MAX - 3) + '_2');
		expect(key).not.toContain('__');
		expect(normalizeConfigKey(key)).toBe(key);
	});
});
