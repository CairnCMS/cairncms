import { describe, expect, it } from 'vitest';
import settingsModule from './index';

const routes = settingsModule.routes as any[];

describe('Settings module routes', () => {
	it('registers the extensions collection route', () => {
		const extensionsRoute = routes.find((route) => route.path === 'extensions');

		expect(extensionsRoute).toBeDefined();

		const child = extensionsRoute.children?.find((c: any) => c.name === 'settings-extensions-collection');

		expect(child).toBeDefined();
		expect(child.path).toBe('');
	});

	it('places the extensions route before the not-found catch-all so it is not shadowed', () => {
		const extensionsIndex = routes.findIndex((route) => route.path === 'extensions');
		const notFoundIndex = routes.findIndex((route) => route.name === 'settings-not-found');

		expect(extensionsIndex).toBeGreaterThanOrEqual(0);
		expect(notFoundIndex).toBeGreaterThanOrEqual(0);
		expect(extensionsIndex).toBeLessThan(notFoundIndex);
	});
});
