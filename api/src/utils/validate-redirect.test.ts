import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isSafeRedirect } from './validate-redirect.js';

const factoryEnv: { [k: string]: any } = {};

vi.mock('../env.js', () => ({
	default: new Proxy(
		{},
		{
			get(_target, prop) {
				return factoryEnv[prop as string];
			},
		}
	),
}));

beforeEach(() => {
	factoryEnv['PUBLIC_URL'] = 'https://cairncms.example';
});

describe('isSafeRedirect — same-origin absolute URLs', () => {
	test.each([
		['plain path', 'https://cairncms.example/admin/content'],
		['with query and fragment', 'https://cairncms.example/path?with=query#frag'],
		['uppercase host (URL parser normalizes)', 'https://CAIRNCMS.example/path'],
	])('allows %s', (_label, redirect) => {
		expect(isSafeRedirect(redirect)).toBe(true);
	});
});

describe('isSafeRedirect — same-origin relative references', () => {
	test.each([
		['root-relative path', '/admin/content'],
		['root', '/'],
		['bare relative path', 'admin/content'],
		['parent-traversal relative path', '../admin/content'],
	])('allows %s', (_label, redirect) => {
		expect(isSafeRedirect(redirect)).toBe(true);
	});
});

describe('isSafeRedirect — cross-origin URLs', () => {
	test.each([
		['different host', 'https://evil.example/path'],
		['scheme mismatch (http vs https)', 'http://cairncms.example/path'],
		['host-suffix attack', 'https://cairncms.example.evil.com/path'],
		['port mismatch', 'https://cairncms.example:8080/path'],
	])('rejects %s', (_label, redirect) => {
		expect(isSafeRedirect(redirect)).toBe(false);
	});
});

describe('isSafeRedirect — protocol-relative URLs', () => {
	test('rejects //evil.example/path', () => {
		expect(isSafeRedirect('//evil.example/path')).toBe(false);
	});
});

describe('isSafeRedirect — non-http(s) schemes', () => {
	test.each([
		['javascript', 'javascript:alert(1)'],
		['data', 'data:text/html,<script>alert(1)</script>'],
		['file', 'file:///etc/passwd'],
	])('rejects %s URL', (_label, redirect) => {
		expect(isSafeRedirect(redirect)).toBe(false);
	});
});

describe('isSafeRedirect — malformed and boundary inputs', () => {
	test('rejects empty string', () => {
		expect(isSafeRedirect('')).toBe(false);
	});

	test('rejects undefined', () => {
		expect(isSafeRedirect(undefined)).toBe(false);
	});

	test('rejects null', () => {
		expect(isSafeRedirect(null)).toBe(false);
	});

	test('rejects non-string numeric', () => {
		expect(isSafeRedirect(42)).toBe(false);
	});

	test('rejects non-string object', () => {
		expect(isSafeRedirect({ url: 'https://cairncms.example' })).toBe(false);
	});
});
