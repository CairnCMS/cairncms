import type { Knex } from 'knex';
import { InvalidPayloadException } from '../exceptions/index.js';
import { decryptSecret, encryptSecret, hasSecretMarker, SECRET_MASK } from '../utils/encrypt-secret.js';

const TABLE = 'directus_operations';

// Reference keys by confined operation type, registered at extension load. Duplicate
// declarations for one type union: an ambiguous type never runs, and over-encrypting
// a key either duplicate declares is safe while under-encrypting leaks.
const secretKeysByType = new Map<string, Set<string>>();

export function registerOperationOptionSecrets(type: string, keys: string[]): void {
	const existing = secretKeysByType.get(type) ?? new Set<string>();
	for (const key of keys) existing.add(key);
	secretKeysByType.set(type, existing);
}

export function clearOperationOptionSecrets(): void {
	secretKeysByType.clear();
}

function declaredKeys(type: unknown): Set<string> {
	if (typeof type !== 'string') return new Set();
	return secretKeysByType.get(type) ?? new Set();
}

/**
 * The declared secret option keys of a stored options object that hold a present value
 * the write path never encrypted. Such a value never functions as a secret at runtime
 * and masks only on a type-carrying read, so the loader surfaces it to the operator.
 */
export function findUnencryptedSecretOptions(type: unknown, options: unknown): string[] {
	if (!isPlainObject(options)) return [];

	return [...declaredKeys(type)].filter((key) => {
		const value = options[key];
		return value !== undefined && value !== null && value !== '' && !hasSecretMarker(value);
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function parseStoredOptions(value: unknown): Record<string, unknown> | undefined {
	if (isPlainObject(value)) return value;
	if (typeof value !== 'string') return undefined;

	try {
		const parsed = JSON.parse(value);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function encryptDeclared(
	options: Record<string, unknown>,
	keys: Set<string>,
	existing: Record<string, unknown> | undefined
): Promise<void> {
	for (const key of keys) {
		const value = options[key];
		if (value === undefined || value === null || value === '') continue;

		if (value === SECRET_MASK) {
			const stored = existing?.[key];

			if (!hasSecretMarker(stored)) {
				throw new InvalidPayloadException(`The option "${key}" carries the mask but has no stored secret.`);
			}

			options[key] = stored;
			continue;
		}

		if (typeof value !== 'string') {
			throw new InvalidPayloadException(`The secret option "${key}" must be a string.`);
		}

		options[key] = await encryptSecret(value);
	}
}

/**
 * Encrypts the declared secret option keys of a new operation in place. The type comes
 * from the payload itself, and there is no stored row, so a mask fails closed.
 */
export async function encryptOperationOptionsForCreate(payload: Record<string, unknown>): Promise<void> {
	if (!isPlainObject(payload['options'])) return;

	const keys = declaredKeys(payload['type']);
	if (keys.size === 0) return;

	await encryptDeclared(payload['options'], keys, undefined);
}

/**
 * Encrypts the declared secret option keys of an operation update in place. The
 * effective type comes from the payload or, since a partial update may omit it, from
 * the stored row, so a partial update cannot slip a declared key through in cleartext.
 * A mask preserves the single targeted row's stored envelope. A multi-row update
 * carrying options for a secret-declaring type is ambiguous (one payload, several
 * stored envelopes) and is rejected rather than resolved arbitrarily.
 */
export async function encryptOperationOptionsForUpdate(
	knex: Knex,
	primaryKeys: (string | number)[],
	payload: Record<string, unknown>
): Promise<void> {
	const payloadType = typeof payload['type'] === 'string' ? payload['type'] : undefined;
	const optionsInPayload = isPlainObject(payload['options']);

	// A type-only change onto a secret-declaring type would reclassify the stored
	// options without this transform seeing them, so it is gated below. Anything else
	// without options in the payload leaves the stored value untouched.
	if (!optionsInPayload && (payloadType === undefined || declaredKeys(payloadType).size === 0)) return;

	const rows: { id: string; type: string; options: unknown }[] = await knex
		.select('id', 'type', 'options')
		.from(TABLE)
		.whereIn('id', primaryKeys);

	if (!optionsInPayload) {
		const keys = declaredKeys(payloadType);

		for (const row of rows) {
			const existing = parseStoredOptions(row.options) ?? {};

			for (const key of keys) {
				const value = existing[key];
				if (value === undefined || value === null || value === '') continue;

				if (!hasSecretMarker(value)) {
					throw new InvalidPayloadException(
						`Changing the type declares the option "${key}" secret; update the options in the same request.`
					);
				}
			}
		}

		return;
	}

	const effectiveTypes = new Set<unknown>(rows.map((row) => payloadType ?? row.type));
	if (payloadType !== undefined) effectiveTypes.add(payloadType);

	const declaring = [...effectiveTypes].filter((type) => declaredKeys(type).size > 0);
	if (declaring.length === 0) return;

	if (primaryKeys.length > 1) {
		throw new InvalidPayloadException('Secret operation options cannot be updated across multiple operations at once.');
	}

	const keys = declaredKeys(declaring[0]);
	const existing = parseStoredOptions(rows[0]?.options);

	await encryptDeclared(payload['options'] as Record<string, unknown>, keys, existing);
}

/**
 * Masks an operation row's secret option values in place for an external read. A value
 * carrying the envelope marker always masks, declaration-independent, so a stale
 * envelope of a removed type still conceals. A value under a currently-declared key
 * masks when the row's type is present in the selection.
 */
export function maskOperationOptions(record: Record<string, unknown>): void {
	const options = record['options'];
	if (!isPlainObject(options)) return;

	const keys = declaredKeys(record['type']);

	for (const [key, value] of Object.entries(options)) {
		if (value === undefined || value === null || value === '') continue;

		if (hasSecretMarker(value) || keys.has(key)) {
			options[key] = SECRET_MASK;
		}
	}
}

// Substituted for a declared secret value the write path never produced. Non-string,
// so the option preparation fails the operation closed before the handler runs.
const NOT_AN_ENVELOPE = Object.freeze({});

/**
 * Resolves the declared secret option keys of a loaded operation to cleartext for the
 * flow runtime, returning a copy. Only an envelope functions as a declared secret: a
 * present value the write path never encrypted is replaced with a non-string the
 * option preparation fails closed, and a tampered or key-orphaned envelope keeps its
 * envelope to the same end, with no raw crypto error thrown here.
 */
export async function decryptOperationOptions(
	options: Record<string, unknown>,
	referenceKeys: string[]
): Promise<Record<string, unknown>> {
	if (!isPlainObject(options)) return options;

	const resolved: Record<string, unknown> = { ...options };

	for (const key of referenceKeys) {
		const value = resolved[key];
		if (value === undefined || value === null || value === '') continue;

		if (!hasSecretMarker(value)) {
			resolved[key] = NOT_AN_ENVELOPE;
			continue;
		}

		try {
			resolved[key] = await decryptSecret(value);
		} catch {
			// the envelope stays, failing closed downstream
		}
	}

	return resolved;
}
