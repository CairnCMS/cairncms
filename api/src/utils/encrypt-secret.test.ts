import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	decryptSecret,
	encryptSecret,
	hasSecretMarker,
	parseKeyMaterial,
	validateSecretsEncryptionKey,
} from './encrypt-secret.js';

let factoryEnv: Record<string, unknown> = {};

vi.mock('../env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => factoryEnv[prop as string] }),
}));

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

describe('encrypt-secret', () => {
	beforeEach(() => {
		factoryEnv = { SECRETS_ENCRYPTION_KEY: KEY_A };
	});

	it('round-trips a secret value', async () => {
		const envelope = await encryptSecret('sk_live_secret');
		expect(await decryptSecret(envelope)).toBe('sk_live_secret');
	});

	it('round-trips an empty secret value', async () => {
		const envelope = await encryptSecret('');
		expect(envelope.ct).toBe('');
		expect(await decryptSecret(envelope)).toBe('');
	});

	it('marks the envelope and never carries the plaintext', async () => {
		const envelope = await encryptSecret('sk_live_secret');
		expect(envelope.kind).toBe('cairncms-secret-envelope');
		expect(hasSecretMarker(envelope)).toBe(true);
		expect(JSON.stringify(envelope)).not.toContain('sk_live_secret');
	});

	it('draws a distinct salt, IV, and ciphertext per encryption of the same value', async () => {
		const a = await encryptSecret('same-value');
		const b = await encryptSecret('same-value');
		expect(a.salt).not.toBe(b.salt);
		expect(a.iv).not.toBe(b.iv);
		expect(a.ct).not.toBe(b.ct);
	});

	it('fails closed on a tampered ciphertext, IV, or tag', async () => {
		const envelope = await encryptSecret('sk_live_secret');

		await expect(
			decryptSecret({ ...envelope, ct: Buffer.from('tampered-bytes').toString('base64') })
		).rejects.toThrow();

		await expect(decryptSecret({ ...envelope, iv: Buffer.alloc(12, 9).toString('base64') })).rejects.toThrow();
		await expect(decryptSecret({ ...envelope, tag: Buffer.alloc(16, 9).toString('base64') })).rejects.toThrow();
	});

	it('pins the GCM tag to 16 bytes and rejects a truncated tag', async () => {
		const envelope = await encryptSecret('sk_live_secret');
		expect(Buffer.from(envelope.tag, 'base64').length).toBe(16);

		const truncatedTag = Buffer.from(envelope.tag, 'base64').subarray(0, 4).toString('base64');
		await expect(decryptSecret({ ...envelope, tag: truncatedTag })).rejects.toThrow();
	});

	it('fails closed when decrypting under a different key', async () => {
		const envelope = await encryptSecret('sk_live_secret');
		factoryEnv['SECRETS_ENCRYPTION_KEY'] = KEY_B;
		await expect(decryptSecret(envelope)).rejects.toThrow();
	});

	it('rejects an envelope failing the versioned contract', async () => {
		const envelope = await encryptSecret('sk_live_secret');
		await expect(decryptSecret({ ...envelope, v: 2 })).rejects.toThrow();
		await expect(decryptSecret({ ...envelope, alg: 'aes-128-gcm' })).rejects.toThrow();
		await expect(decryptSecret({ ...envelope, kid: 'kms:rotated' })).rejects.toThrow();
		await expect(decryptSecret({ ...envelope, salt: Buffer.alloc(8).toString('base64') })).rejects.toThrow();
		await expect(decryptSecret({ ...envelope, iv: Buffer.alloc(16).toString('base64') })).rejects.toThrow();
		await expect(decryptSecret({ kind: 'other' })).rejects.toThrow();
	});

	it('requires a present, sufficiently long key at use', async () => {
		factoryEnv = {};
		await expect(encryptSecret('x')).rejects.toThrow();

		factoryEnv = { SECRETS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') };
		await expect(encryptSecret('x')).rejects.toThrow();
	});

	it('parseKeyMaterial trims a trailing newline and rejects non-canonical or short keys', () => {
		expect(parseKeyMaterial(`${KEY_A}\n`).length).toBe(32);
		expect(() => parseKeyMaterial(KEY_A.replace(/=+$/, ''))).toThrow();
		expect(() => parseKeyMaterial(Buffer.alloc(16).toString('base64'))).toThrow();
		expect(() => parseKeyMaterial(undefined)).toThrow();
	});

	it('validateSecretsEncryptionKey passes when absent or valid and throws when set but malformed', () => {
		factoryEnv = {};
		expect(() => validateSecretsEncryptionKey()).not.toThrow();

		factoryEnv = { SECRETS_ENCRYPTION_KEY: KEY_A };
		expect(() => validateSecretsEncryptionKey()).not.toThrow();

		factoryEnv = { SECRETS_ENCRYPTION_KEY: 'not-a-valid-key' };
		expect(() => validateSecretsEncryptionKey()).toThrow();
	});

	it('rejects a non-envelope for the marker check', () => {
		expect(hasSecretMarker(null)).toBe(false);
		expect(hasSecretMarker('sk_live_secret')).toBe(false);
		expect(hasSecretMarker({ kind: 'other' })).toBe(false);
	});

	it('pins the marker and decrypt split: a bare marker masks but never decrypts', async () => {
		const bareMarker = { kind: 'cairncms-secret-envelope' };
		expect(hasSecretMarker(bareMarker)).toBe(true);
		await expect(decryptSecret(bareMarker)).rejects.toThrow();
	});
});
