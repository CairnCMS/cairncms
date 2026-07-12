import { describe, expect, it } from 'vitest';
import { safeLogFragment } from './safe-log-fragment.js';

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
