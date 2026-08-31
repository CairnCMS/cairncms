import { createHash } from 'node:crypto';
import type { ConfigKind } from '../../types/config.js';
import { canonicalEncode } from './canonical-encode.js';
import type { ConfigReadMode, ReadStateProjection } from './descriptor.js';

export type StateDigestEntry = {
	kind: ConfigKind;
	mode: ConfigReadMode;
	identities: string[];
	values?: Array<[string, unknown]>;
};

/** Fails closed if a handler projection omits values in `full` mode or reports a mode other than the one it was read in. */
export function toStateDigestEntry(
	kind: ConfigKind,
	mode: ConfigReadMode,
	projection: ReadStateProjection
): StateDigestEntry {
	if (projection.mode !== mode) {
		throw new Error(`Config state projection for "${kind}" reported mode "${projection.mode}" for a "${mode}" read.`);
	}

	const { identities } = projection;
	const hasValues = Object.hasOwn(projection, 'values');
	const values = (projection as { values?: unknown }).values;

	if (!Array.isArray(identities)) {
		throw new Error(`Config state projection for "${kind}" produced non-array identities.`);
	}

	if (mode === 'full') {
		if (!hasValues || !Array.isArray(values)) {
			throw new Error(`Config state projection for "${kind}" omitted values in full mode.`);
		}

		return { kind, mode: 'full', identities, values: values as Array<[string, unknown]> };
	}

	if (hasValues) {
		throw new Error(`Config state projection for "${kind}" produced values in identity mode.`);
	}

	return { kind, mode: 'identity', identities };
}

/**
 * Hashes the read-closure entries into the digest half of a `ConfigStateToken`. The entries arrive in dependency
 * order with identities and values already sorted by the handler projection; this canonically encodes them and
 * returns a SHA-256 hex digest.
 */
export function computeConfigStateDigest(entries: StateDigestEntry[]): string {
	const canonical = canonicalEncode(entries);

	return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
