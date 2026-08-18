import { describe, expect, it } from 'vitest';
import { getAnonymousAccountability } from './get-anonymous-accountability.js';

describe('getAnonymousAccountability', () => {
	it('builds the canonical anonymous identity with the given ip', () => {
		expect(getAnonymousAccountability({ ip: '203.0.113.7' })).toEqual({
			user: null,
			role: null,
			admin: false,
			app: false,
			ip: '203.0.113.7',
		});
	});

	it('includes user-agent and origin when truthy', () => {
		expect(getAnonymousAccountability({ ip: '203.0.113.7', userAgent: 'an-agent', origin: 'an-origin' })).toEqual({
			user: null,
			role: null,
			admin: false,
			app: false,
			ip: '203.0.113.7',
			userAgent: 'an-agent',
			origin: 'an-origin',
		});
	});

	it('omits user-agent and origin when null or absent', () => {
		const accountability = getAnonymousAccountability({ ip: '203.0.113.7', userAgent: null, origin: undefined });
		expect('userAgent' in accountability).toBe(false);
		expect('origin' in accountability).toBe(false);
	});
});
