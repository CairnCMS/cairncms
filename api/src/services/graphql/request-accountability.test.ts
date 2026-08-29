import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { authenticationAccountabilityFromRequest } from './request-accountability.js';

vi.mock('../../utils/get-ip-from-req.js', () => ({
	getIPFromReq: vi.fn(() => '203.0.113.200'),
}));

const SENTINEL = '203.0.113.200';

function makeReq(headers: Record<string, string> = {}): Request {
	return { get: (name: string) => headers[name.toLowerCase()], ip: '127.0.0.1' } as unknown as Request;
}

describe('authenticationAccountabilityFromRequest', () => {
	it('throws when request context is absent', () => {
		expect(() => authenticationAccountabilityFromRequest(undefined)).toThrow(
			'GraphQL authentication requires request context'
		);
	});

	it('returns the canonical anonymous shape with user-agent and origin when present', () => {
		expect(
			authenticationAccountabilityFromRequest(makeReq({ 'user-agent': 'a-user-agent', origin: 'an-origin' }))
		).toEqual({
			user: null,
			role: null,
			admin: false,
			app: false,
			ip: SENTINEL,
			userAgent: 'a-user-agent',
			origin: 'an-origin',
		});
	});

	it('returns the canonical anonymous shape without user-agent and origin when absent', () => {
		expect(authenticationAccountabilityFromRequest(makeReq())).toEqual({
			user: null,
			role: null,
			admin: false,
			app: false,
			ip: SENTINEL,
		});
	});
});
