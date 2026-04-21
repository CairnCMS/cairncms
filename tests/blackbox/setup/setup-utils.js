const argon2 = require('argon2');

exports.hash = function (stringToHash) {
	const buffer = 'string';
	// Disallow HASH_RAW — argon2's raw mode returns a Buffer instead of the encoded string verify() expects.
	const argon2HashConfigOptions = { test: 'test', associatedData: buffer };
	// argon2.hash requires associatedData to be a Buffer when provided.
	if ('test' in argon2HashConfigOptions)
		argon2HashConfigOptions.associatedData = Buffer.from(argon2HashConfigOptions.associatedData);
	return argon2.hash(stringToHash, argon2HashConfigOptions);
};
