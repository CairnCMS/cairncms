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
	it('attributes the resolved client IP when a request is present', () => {
		expect(authenticationAccountabilityFromRequest(makeReq()).ip).toBe(SENTINEL);
	});

	it('throws when request context is absent', () => {
		expect(() => authenticationAccountabilityFromRequest(undefined)).toThrow(
			'GraphQL authentication requires request context'
		);
	});

	it('defaults role to null', () => {
		expect(authenticationAccountabilityFromRequest(makeReq()).role).toBeNull();
	});

	it('captures user-agent and origin when present', () => {
		const accountability = authenticationAccountabilityFromRequest(
			makeReq({ 'user-agent': 'a-user-agent', origin: 'an-origin' })
		);

		expect(accountability.userAgent).toBe('a-user-agent');
		expect(accountability.origin).toBe('an-origin');
	});

	it('omits user-agent and origin when absent', () => {
		const accountability = authenticationAccountabilityFromRequest(makeReq());
		expect(accountability.userAgent).toBeUndefined();
		expect(accountability.origin).toBeUndefined();
	});
});
