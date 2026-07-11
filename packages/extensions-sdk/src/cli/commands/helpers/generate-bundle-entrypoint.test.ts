import { describe, expect, it } from 'vitest';
import generateBundleEntrypoint from './generate-bundle-entrypoint.js';

describe('generateBundleEntrypoint', () => {
	it('exports app entries grouped under identifier-safe pluralized names', () => {
		const out = generateBundleEntrypoint('app', [
			{ type: 'interface', name: 'ui', source: 'src/ui.js' },
			{ type: 'panel', name: 'pn', source: 'src/pn.js' },
		] as never);

		expect(out).toContain('export const interfaces = [e0];');
		expect(out).toContain('export const panels = [e1];');
	});

	it('exports item-view entries under the hyphenated key via a string export name', () => {
		const out = generateBundleEntrypoint('app', [{ type: 'item-view', name: 'iv', source: 'src/iv.js' }] as never);

		expect(out).toContain('const itemViews = [e0];');
		expect(out).toContain('export { itemViews as "item-views" };');
		expect(out).not.toContain('export const item-views');
	});

	it('excludes item-view entries from the api bundle', () => {
		const out = generateBundleEntrypoint('api', [
			{ type: 'item-view', name: 'iv', source: 'src/iv.js' },
			{ type: 'hook', name: 'hk', source: 'src/hk.js' },
		] as never);

		expect(out).not.toContain('item');
		expect(out).toContain("export const hooks = [{name:'hk',config:e0}];");
	});
});
