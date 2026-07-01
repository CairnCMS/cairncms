import { createCipheriv, createDecipheriv, hkdf, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import env from '../env.js';

const ENVELOPE_KIND = 'cairncms-secret-envelope';
const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DEFAULT_KID = 'env:default';

// HKDF parameters are fixed. Changing the digest or info would derive a different key for
// the same material and salt, breaking every existing envelope.
const HKDF_DIGEST = 'sha256';
const HKDF_INFO = 'cairncms-secret-envelope';

const DERIVED_KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_KEY_BYTES = 32;

const hkdfAsync = promisify(hkdf);

export const SECRET_MASK = '**********';

export interface SecretEnvelope {
	kind: typeof ENVELOPE_KIND;
	v: typeof ENVELOPE_VERSION;
	alg: typeof ALGORITHM;
	kid: string;
	salt: string;
	iv: string;
	ct: string;
	tag: string;
}

// Decodes a base64 field and rejects non-canonical input, so trailing garbage or a wrong
// padding in a stored value is caught before the bytes are used.
function decodeBase64(value: string, field: string): Buffer {
	const buffer = Buffer.from(value, 'base64');

	if (buffer.toString('base64') !== value) {
		throw new Error(`the secret envelope ${field} is malformed`);
	}

	return buffer;
}

function decodeExact(value: string, bytes: number, field: string): Buffer {
	const buffer = decodeBase64(value, field);
	if (buffer.length !== bytes) throw new Error(`the secret envelope ${field} is malformed`);
	return buffer;
}

/**
 * Parses the SECRETS_ENCRYPTION_KEY material strictly. Trims surrounding whitespace, since a
 * `_FILE` secret often carries a trailing newline, requires canonical base64 decoding to at
 * least 32 bytes, and throws otherwise.
 */
export function parseKeyMaterial(raw: unknown): Buffer {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new Error('SECRETS_ENCRYPTION_KEY is required to encrypt or decrypt a declared secret.');
	}

	const trimmed = raw.trim();
	const keyMaterial = Buffer.from(trimmed, 'base64');

	if (keyMaterial.toString('base64') !== trimmed || keyMaterial.length < MIN_KEY_BYTES) {
		throw new Error('SECRETS_ENCRYPTION_KEY must be canonical base64 decoding to at least 32 bytes of entropy.');
	}

	return keyMaterial;
}

/**
 * Validates SECRETS_ENCRYPTION_KEY when it is set, so a malformed key is caught at startup
 * rather than at first secret use. An unset key is allowed and skipped.
 */
export function validateSecretsEncryptionKey(): void {
	if (env['SECRETS_ENCRYPTION_KEY'] !== undefined) parseKeyMaterial(env['SECRETS_ENCRYPTION_KEY']);
}

function resolveKeyMaterial(kid: string): Buffer {
	if (kid !== DEFAULT_KID) {
		throw new Error('no secret encryption key is available for this envelope');
	}

	return parseKeyMaterial(env['SECRETS_ENCRYPTION_KEY']);
}

async function deriveKey(keyMaterial: Buffer, salt: Buffer): Promise<Buffer> {
	return Buffer.from(await hkdfAsync(HKDF_DIGEST, keyMaterial, salt, HKDF_INFO, DERIVED_KEY_BYTES));
}

/**
 * Encrypts a secret value into a marked AES-256-GCM envelope. A fresh salt and IV are drawn
 * per call, so encrypting the same value twice yields distinct envelopes. Requires
 * SECRETS_ENCRYPTION_KEY and rejects a missing or malformed key.
 */
export async function encryptSecret(plaintext: string): Promise<SecretEnvelope> {
	const keyMaterial = resolveKeyMaterial(DEFAULT_KID);
	const salt = randomBytes(SALT_BYTES);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, await deriveKey(keyMaterial, salt), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

	return {
		kind: ENVELOPE_KIND,
		v: ENVELOPE_VERSION,
		alg: ALGORITHM,
		kid: DEFAULT_KID,
		salt: salt.toString('base64'),
		iv: iv.toString('base64'),
		ct: ct.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
	};
}

// Validates a runtime value against the envelope contract before decryption, so the marker
// is only a masking signal and never a decryption input. A value carrying the marker but
// failing any check is rejected.
function parseEnvelope(value: unknown): { salt: Buffer; iv: Buffer; ct: Buffer; tag: Buffer } {
	if (!hasSecretMarker(value)) throw new Error('the value is not a secret envelope');

	const record = value as Record<string, unknown>;

	if (record['v'] !== ENVELOPE_VERSION || record['alg'] !== ALGORITHM || record['kid'] !== DEFAULT_KID) {
		throw new Error('the secret envelope is unsupported');
	}

	if (
		typeof record['salt'] !== 'string' ||
		typeof record['iv'] !== 'string' ||
		typeof record['ct'] !== 'string' ||
		typeof record['tag'] !== 'string'
	) {
		throw new Error('the secret envelope is malformed');
	}

	return {
		salt: decodeExact(record['salt'], SALT_BYTES, 'salt'),
		iv: decodeExact(record['iv'], IV_BYTES, 'iv'),
		ct: decodeBase64(record['ct'], 'ct'),
		tag: decodeExact(record['tag'], TAG_BYTES, 'tag'),
	};
}

/**
 * Decrypts a marked envelope server-side. Validates the envelope contract first, then fails
 * closed by throwing on a tampered ciphertext, IV, or tag through the GCM tag check, and on
 * an envelope whose key id resolves to no key.
 */
export async function decryptSecret(value: unknown): Promise<string> {
	const parsed = parseEnvelope(value);
	const keyMaterial = resolveKeyMaterial(DEFAULT_KID);
	const decipher = createDecipheriv(ALGORITHM, await deriveKey(keyMaterial, parsed.salt), parsed.iv);
	decipher.setAuthTag(parsed.tag);

	return Buffer.concat([decipher.update(parsed.ct), decipher.final()]).toString('utf8');
}

/**
 * True when a value carries the secret-envelope marker. This is the masking signal only, so
 * any external serialization of a value it tags yields the mask. It is not a full validation
 * of the envelope, decryption validates the contract separately.
 */
export function hasSecretMarker(value: unknown): boolean {
	return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === ENVELOPE_KIND;
}
