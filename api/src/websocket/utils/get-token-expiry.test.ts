import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { getTokenExpiry } from './get-token-expiry.js';

describe('getTokenExpiry', () => {
	it('returns the exp claim of a signed token', () => {
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const token = jwt.sign({ id: 'alice', exp }, 'secret');
		expect(getTokenExpiry(token)).toBe(exp);
	});

	it('returns null for a token without an exp claim', () => {
		const token = jwt.sign({ id: 'alice' }, 'secret');
		expect(getTokenExpiry(token)).toBeNull();
	});

	it('returns null for a non-JWT string', () => {
		expect(getTokenExpiry('a-static-database-token')).toBeNull();
	});
});
