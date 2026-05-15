import argon2 from 'argon2';
import { InvalidPayloadException } from '../exceptions/index.js';

export async function verifyHash(hash: string, stringToVerify: string): Promise<boolean> {
	try {
		return await argon2.verify(hash, stringToVerify);
	} catch {
		throw new InvalidPayloadException(`"hash" must be a valid argon2 hash`);
	}
}
