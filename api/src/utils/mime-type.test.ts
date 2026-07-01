import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeMimeType, resolveMimeType } from './mime-type.js';

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

afterEach(() => {
	delete factoryEnv['FILES_MIME_TYPE_ALLOW_LIST'];
});

describe('normalizeMimeType', () => {
	it('strips parameters, lowercases, and trims', () => {
		expect(normalizeMimeType('image/JPEG; charset=utf-8')).toBe('image/jpeg');
		expect(normalizeMimeType('  application/PDF  ')).toBe('application/pdf');
	});

	it('falls back to application/octet-stream for a missing or blank type', () => {
		expect(normalizeMimeType(undefined)).toBe('application/octet-stream');
		expect(normalizeMimeType(null)).toBe('application/octet-stream');
		expect(normalizeMimeType('')).toBe('application/octet-stream');
	});
});

describe('resolveMimeType', () => {
	it('allows everything under the default */*', () => {
		factoryEnv['FILES_MIME_TYPE_ALLOW_LIST'] = '*/*';
		expect(resolveMimeType('application/pdf')).toEqual({ mimeType: 'application/pdf', allowed: true });
	});

	it('matches glob patterns and rejects others', () => {
		factoryEnv['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*';
		expect(resolveMimeType('image/png').allowed).toBe(true);
		expect(resolveMimeType('application/pdf').allowed).toBe(false);
	});

	it('honors a comma-separated list with surrounding whitespace', () => {
		factoryEnv['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*, application/pdf';
		expect(resolveMimeType('image/png').allowed).toBe(true);
		expect(resolveMimeType('application/pdf').allowed).toBe(true);
		expect(resolveMimeType('text/html').allowed).toBe(false);
	});

	it('normalizes before matching and returns the normalized type for storage', () => {
		factoryEnv['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*';
		expect(resolveMimeType('image/jpeg; charset=utf-8')).toEqual({ mimeType: 'image/jpeg', allowed: true });
	});

	it('treats a missing type as application/octet-stream, denied under a restrictive list', () => {
		factoryEnv['FILES_MIME_TYPE_ALLOW_LIST'] = 'image/*';
		expect(resolveMimeType(undefined)).toEqual({ mimeType: 'application/octet-stream', allowed: false });
	});
});
