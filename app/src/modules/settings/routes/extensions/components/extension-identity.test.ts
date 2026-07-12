import { describe, expect, it } from 'vitest';
import { extensionIdentity } from './extension-identity';

describe('extensionIdentity', () => {
	it('derives the title from the local name', () => {
		expect(extensionIdentity('cairncms-extension-review-flow')).toEqual({
			packageName: 'cairncms-extension-review-flow',
			title: 'Review Flow',
		});
	});

	it('keeps the scope on a scoped package', () => {
		expect(extensionIdentity('@acme/cairncms-extension-preview')).toEqual({
			packageName: '@acme/cairncms-extension-preview',
			title: 'Preview',
			scope: '@acme',
		});

		expect(extensionIdentity('@cairncms/extension-preview')).toEqual({
			packageName: '@cairncms/extension-preview',
			title: 'Preview',
			scope: '@cairncms',
		});
	});

	it('distinguishes two scoped packages with the same local name by package name', () => {
		const a = extensionIdentity('@acme/cairncms-extension-preview');
		const b = extensionIdentity('@vendor/cairncms-extension-preview');

		expect(a.title).toBe(b.title);
		expect(a.packageName).not.toBe(b.packageName);
	});

	it('falls back to the package name when no local name derives', () => {
		expect(extensionIdentity('my-settings-widget')).toEqual({
			packageName: 'my-settings-widget',
			title: 'my-settings-widget',
		});
	});
});
