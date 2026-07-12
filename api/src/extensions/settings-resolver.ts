import { getExtensionConfigSecretName } from '@cairncms/constants';
import { decryptSecret, hasSecretMarker } from '../utils/encrypt-secret.js';

export type DeclaredSetting = { type: string; secret: 'inline' | 'config' | undefined };

/**
 * Resolves a declared non-secret setting from its stored value. A secret declaration, a type
 * mismatch against the declaration, and a non-finite number all resolve null.
 */
export function resolveDeclaredValue(declared: DeclaredSetting, stored: unknown): unknown {
	if (declared.secret !== undefined) return null;
	if (typeof stored !== declared.type) return null;
	if (declared.type === 'number' && !Number.isFinite(stored)) return null;

	return stored;
}

/**
 * Resolves a declared secret setting to its raw material. A config secret reads its derived
 * variable from raw `process.env`, never the coerced env object, and only a non-empty string
 * resolves. An inline secret decrypts its stored envelope and fails closed to null on a
 * missing marker, a tampered envelope, or unavailable key material. The confined broker mints
 * references above this; the material itself never varies by consumer.
 */
export async function resolveDeclaredSecret(
	subject: string,
	key: string,
	declared: DeclaredSetting,
	readStored: () => Promise<unknown>
): Promise<string | null> {
	if (declared.secret === undefined) return null;

	if (declared.secret === 'config') {
		const raw = process.env[getExtensionConfigSecretName(subject, key)];
		return typeof raw === 'string' && raw.length > 0 ? raw : null;
	}

	const value = await readStored();
	if (!hasSecretMarker(value)) return null;

	try {
		return await decryptSecret(value);
	} catch {
		return null;
	}
}
