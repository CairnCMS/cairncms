import argon2 from 'argon2';
import { getConfigFromEnv } from './get-config-from-env.js';

export function generateHash(stringToHash: string): Promise<string> {
	// Disallow HASH_RAW — argon2's raw mode returns a Buffer instead of the encoded string verify() expects.
	const argon2HashConfigOptions = getConfigFromEnv('HASH_', 'HASH_RAW');

	// argon2.hash requires associatedData to be a Buffer when provided.
	'associatedData' in argon2HashConfigOptions &&
		(argon2HashConfigOptions['associatedData'] = Buffer.from(argon2HashConfigOptions['associatedData']));

	return argon2.hash(stringToHash, argon2HashConfigOptions);
}
