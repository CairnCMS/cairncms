import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { InvalidPayloadException } from '../exceptions/index.js';
import { verifyHash } from './verify-hash.js';

describe('verifyHash', () => {
	describe('bug-exposing — malformed hashes map to InvalidPayloadException', () => {
		it('throws InvalidPayloadException when the hash is not an argon2 hash', async () => {
			await expect(verifyHash('not-an-argon2-hash', 'anything')).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('error message references the hash being invalid', async () => {
			await expect(verifyHash('not-a-hash', 'x')).rejects.toThrow(/argon2/);
		});

		it('throws InvalidPayloadException on an empty hash string', async () => {
			await expect(verifyHash('', 'anything')).rejects.toBeInstanceOf(InvalidPayloadException);
		});
	});

	describe('regression — valid hashes still verify', () => {
		it('returns true when the hash matches the input string', async () => {
			const hash = await argon2.hash('correct-string');
			await expect(verifyHash(hash, 'correct-string')).resolves.toBe(true);
		});

		it('returns false when the hash does not match the input string', async () => {
			const hash = await argon2.hash('correct-string');
			await expect(verifyHash(hash, 'wrong-string')).resolves.toBe(false);
		});
	});
});
