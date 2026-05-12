import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getSafeRedirect, getSafeRedirectWithReason, isSafeRedirect } from './validate-redirect.js';

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

describe('getSafeRedirect — canonicalizes safe inputs to path-local form', () => {
	test('safe absolute URL returns path-only, dropping origin', () => {
		expect(getSafeRedirect('https://cairncms.example/admin/content')).toBe('/admin/content');
	});

	test('safe absolute URL with query and hash preserves them', () => {
		expect(getSafeRedirect('https://cairncms.example/admin?foo=1#section')).toBe('/admin?foo=1#section');
	});

	test('safe relative path passes through as-is', () => {
		expect(getSafeRedirect('/admin/content')).toBe('/admin/content');
	});

	test('safe bare-relative path resolves to root-relative form', () => {
		expect(getSafeRedirect('admin/content')).toBe('/admin/content');
	});

	test('safe parent-traversal path resolves under origin', () => {
		expect(getSafeRedirect('../admin')).toBe('/admin');
	});

	test('cross-origin absolute URL returns null', () => {
		expect(getSafeRedirect('https://evil.example/path')).toBeNull();
	});

	test('protocol-relative URL returns null', () => {
		expect(getSafeRedirect('//evil.example/path')).toBeNull();
	});

	test('javascript: URL returns null', () => {
		expect(getSafeRedirect('javascript:alert(1)')).toBeNull();
	});

	test('empty string returns null', () => {
		expect(getSafeRedirect('')).toBeNull();
	});

	test('undefined returns null', () => {
		expect(getSafeRedirect(undefined)).toBeNull();
	});
});

describe('getSafeRedirectWithReason — drops query/hash and sets reason', () => {
	test('safe absolute URL with no query returns path with reason', () => {
		expect(getSafeRedirectWithReason('https://cairncms.example/admin', 'TOKEN_EXPIRED')).toBe(
			'/admin?reason=TOKEN_EXPIRED'
		);
	});

	test('safe absolute URL with existing query has the query dropped', () => {
		expect(getSafeRedirectWithReason('https://cairncms.example/admin?foo=1&bar=2', 'TOKEN_EXPIRED')).toBe(
			'/admin?reason=TOKEN_EXPIRED'
		);
	});

	test('safe absolute URL with hash has the hash dropped', () => {
		expect(getSafeRedirectWithReason('https://cairncms.example/admin#section', 'TOKEN_EXPIRED')).toBe(
			'/admin?reason=TOKEN_EXPIRED'
		);
	});

	test('safe relative path returns path with reason', () => {
		expect(getSafeRedirectWithReason('/admin', 'TOKEN_EXPIRED')).toBe('/admin?reason=TOKEN_EXPIRED');
	});

	test('reason value with special characters is URL-encoded', () => {
		expect(getSafeRedirectWithReason('/admin', 'A B&C')).toBe('/admin?reason=A+B%26C');
	});

	test('cross-origin absolute URL returns null', () => {
		expect(getSafeRedirectWithReason('https://evil.example/path', 'TOKEN_EXPIRED')).toBeNull();
	});

	test('protocol-relative URL returns null', () => {
		expect(getSafeRedirectWithReason('//evil.example', 'TOKEN_EXPIRED')).toBeNull();
	});

	test('empty string returns null', () => {
		expect(getSafeRedirectWithReason('', 'TOKEN_EXPIRED')).toBeNull();
	});

	test('undefined returns null', () => {
		expect(getSafeRedirectWithReason(undefined, 'TOKEN_EXPIRED')).toBeNull();
	});
});
