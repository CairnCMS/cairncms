import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRouter, createWebHistory, Router } from 'vue-router';

const ROUTES = [
	{ path: '/tfa-setup', component: { template: '<div>tfa-setup</div>' } },
	{ path: '/login', component: { template: '<div>login</div>' } },
	{ path: '/content', component: { template: '<div>content</div>' } },
	{ path: '/:_(.+)+', component: { template: '<div>404</div>' } },
];

let router: Router;
let pushStateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	pushStateSpy = vi.spyOn(window.history, 'pushState');
	router = createRouter({ history: createWebHistory('/admin/'), routes: ROUTES });
	await router.push('/tfa-setup');
	await router.isReady();
	pushStateSpy.mockClear();
});

afterEach(() => {
	pushStateSpy.mockRestore();
});

function lastPushStateURL(): string {
	const calls = pushStateSpy.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1]![2] as string;
}

describe('tfa-setup redirect sink — same-origin contract (GHSA-q75c-4gmv-mg9x)', () => {
	test.each([
		['protocol-relative', '//evil.example/path'],
		['absolute http URL', 'http://evil.example/path'],
		['absolute https URL', 'https://evil.example/path'],
		['leading double-backslash', '\\\\evil.example/path'],
		['slash then backslash', '/\\evil.example/path'],
		['backslash then slash', '\\/evil.example/path'],
		['multiple leading slashes', '////evil.example/path'],
		['userinfo bypass', '\\\\user@evil.example/path'],
		['javascript scheme', 'javascript:alert(1)'],
		['data scheme', 'data:text/html,<script>alert(1)</script>'],
	])('router.push(%s) keeps the navigation URL same-origin', async (_label, redirect) => {
		await router.push(redirect).catch(() => undefined);

		const navigatedURL = lastPushStateURL();
		const parsed = new URL(navigatedURL, window.location.origin);

		expect(parsed.origin).toBe(window.location.origin);
		expect(parsed.pathname.startsWith('/admin/')).toBe(true);
	});

	test('router.push of a same-origin path navigates under the admin base', async () => {
		await router.push('/content');
		const navigatedURL = lastPushStateURL();
		const parsed = new URL(navigatedURL, window.location.origin);
		expect(parsed.origin).toBe(window.location.origin);
		expect(parsed.pathname).toBe('/admin/content');
	});
});
