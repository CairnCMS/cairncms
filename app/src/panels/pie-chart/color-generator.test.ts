import { describe, it, expect } from 'vitest';
import { monoThemeGenerator } from './color-generator';

describe('panels/pie-chart/monoThemeGenerator', () => {
	it('Returns the requested number of colors', () => {
		const theme = monoThemeGenerator('#3399ff', 5);
		expect(theme).toHaveLength(5);
	});

	it('Preserves the base color as the first entry', () => {
		const theme = monoThemeGenerator('#3399ff', 4);
		expect(theme[0]).toBe('#3399ff');
	});

	it('Produces valid 7-character hex strings for every color', () => {
		const theme = monoThemeGenerator('#7c5cff', 8);
		const hex = /^#[0-9a-f]{6}$/i;

		for (const color of theme) {
			expect(color).toMatch(hex);
		}
	});

	it('Returns only the base color when length is 1', () => {
		const theme = monoThemeGenerator('#ff8800', 1);
		expect(theme).toEqual(['#ff8800']);
	});

	it('Terminates and produces the requested count for a high length', () => {
		const theme = monoThemeGenerator('#3399ff', 12);
		expect(theme).toHaveLength(12);
	});
});
