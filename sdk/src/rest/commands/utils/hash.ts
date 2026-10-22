import type { RestCommand } from '../../types.js';

/**
 * Generate a hash for a given string. This endpoint is only available to admin users.
 * @param string String to hash.
 * @returns Hashed string.
 * @deprecated Hash and verify values in your own application with an Argon2 package, such as `argon2` for Node.js. Removal is planned for 1.8.0 or later.
 */
export const generateHash =
	<Schema>(string: string): RestCommand<string, Schema> =>
	() => ({
		method: 'POST',
		path: `/utils/hash/generate`,
		body: JSON.stringify({ string }),
	});

/**
 * Verify a string with a hash. This endpoint is only available to admin users.
 * @param string Source string.
 * @param hash Hash you want to verify against.
 * @returns Boolean.
 * @deprecated Hash and verify values in your own application with an Argon2 package, such as `argon2` for Node.js. Removal is planned for 1.8.0 or later.
 */
export const verifyHash =
	<Schema>(string: string, hash: string): RestCommand<boolean, Schema> =>
	() => ({
		method: 'POST',
		path: `/utils/hash/verify`,
		body: JSON.stringify({ string, hash }),
	});
