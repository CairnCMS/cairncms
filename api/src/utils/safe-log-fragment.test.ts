import { describe, expect, it } from 'vitest';
import { replaceControlCharacters, safeLogFragment } from './safe-log-fragment.js';

describe('replaceControlCharacters', () => {
	it('replaces C0 and C1 control characters', () => {
		expect(replaceControlCharacters(`a${String.fromCharCode(10)}b${String.fromCharCode(27)}[31mc`)).toBe('a?b?[31mc');
		expect(replaceControlCharacters(`x${String.fromCharCode(0)}y${String.fromCharCode(0x9b)}z`)).toBe('x?y?z');
	});

	it('keeps a long value whole, so a diagnostic never loses its tail', () => {
		const long = `${'d'.repeat(400)}${String.fromCharCode(27)}[0m${'e'.repeat(400)}`;
		const result = replaceControlCharacters(long);

		expect(result).toHaveLength(long.length);
		expect(result.endsWith('e'.repeat(400))).toBe(true);
		expect(result).not.toContain(String.fromCharCode(27));
		expect(result).not.toContain('...');
	});

	it('renders a non-string value through String()', () => {
		expect(replaceControlCharacters(42)).toBe('42');
	});
});

describe('safeLogFragment', () => {
	it('replaces C0 and C1 control characters so a fragment cannot split or style a log line', () => {
		expect(safeLogFragment(`a${String.fromCharCode(10)}b${String.fromCharCode(27)}[31mc`)).toBe('a?b?[31mc');
		expect(safeLogFragment(`x${String.fromCharCode(0)}y${String.fromCharCode(0x9b)}z`)).toBe('x?y?z');
	});

	it('truncates an overlong fragment', () => {
		expect(safeLogFragment('x'.repeat(100))).toBe(`${'x'.repeat(64)}...`);
		expect(safeLogFragment('x'.repeat(10), 4)).toBe('xxxx...');
	});

	it('renders a non-string value through String()', () => {
		expect(safeLogFragment(42)).toBe('42');
		expect(safeLogFragment(null)).toBe('null');
	});

	it('leaves a conventional fragment unchanged', () => {
		expect(safeLogFragment('op-1c2d3e')).toBe('op-1c2d3e');
	});
});
