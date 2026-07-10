import { APP_SHARED_DEPS } from '@cairncms/constants';
import { describe, expect, it } from 'vitest';
import { findSharedDepAsset } from './app-bundle.js';

describe('findSharedDepAsset', () => {
	// Real Vite [hash] entry chunk names: base64url (mixed case with - and _),
	// not lowercase hex.
	const assets = [
		'@cairncms_extensions-sdk.DkPq34sU.entry.js',
		'vue.ev7YwI6S.entry.js',
		'vue-router.1bIbD7IL.entry.js',
		'vue-i18n.Bj4wzLyX.entry.js',
		'pinia.Ct9JND4I.entry.js',
		'vue.runtime.esm-bundler-BsuNjI30.js',
	];

	it('resolves every APP_SHARED_DEP against base64url Vite hashes', () => {
		for (const dep of APP_SHARED_DEPS) {
			expect(findSharedDepAsset(dep, assets), dep).toBeDefined();
		}
	});

	it('maps each dep to its own entry chunk', () => {
		expect(findSharedDepAsset('vue', assets)).toBe('vue.ev7YwI6S.entry.js');

		expect(findSharedDepAsset('@cairncms/extensions-sdk', assets)).toBe('@cairncms_extensions-sdk.DkPq34sU.entry.js');
	});

	it('anchors the name so vue does not match vue-router or a substring chunk', () => {
		expect(findSharedDepAsset('vue', ['vue-router.1bIbD7IL.entry.js'])).toBeUndefined();
		expect(findSharedDepAsset('vue', ['somevue.DkPq34sU.entry.js'])).toBeUndefined();
	});

	it('only matches an .entry.js chunk, not a plain dep chunk', () => {
		expect(findSharedDepAsset('vue', ['vue.runtime.esm-bundler-BsuNjI30.js'])).toBeUndefined();
	});
});
