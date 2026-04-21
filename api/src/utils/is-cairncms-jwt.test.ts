import isCairnJWT from '../../src/utils/is-cairncms-jwt.js';
import jwt from 'jsonwebtoken';
import { test, expect } from 'vitest';

test('Returns false for non JWT string', () => {
	const result = isCairnJWT('test');
	expect(result).toBe(false);
});

test('Returns false for JWTs with text payload', () => {
	const token = jwt.sign('plaintext', 'secret');
	const result = isCairnJWT(token);
	expect(result).toBe(false);
});

test(`Returns false if token issuer isn't "cairncms"`, () => {
	const token = jwt.sign({ payload: 'content' }, 'secret', { issuer: 'rijk' });
	const result = isCairnJWT(token);
	expect(result).toBe(false);
});

test(`Returns true if token is valid JWT and issuer is "cairncms"`, () => {
	const token = jwt.sign({ payload: 'content' }, 'secret', { issuer: 'cairncms' });
	const result = isCairnJWT(token);
	expect(result).toBe(true);
});
