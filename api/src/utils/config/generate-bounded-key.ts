import { normalizeConfigKey } from '@cairncms/utils';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../config-contract.js';

const NO_RESERVED_KEYS: ReadonlySet<string> = new Set();

function boundStem(candidate: string, fallback: string, suffix?: number): string {
	if (suffix === undefined) {
		return candidate.slice(0, CONFIG_FILENAME_STEM_MAX_LENGTH);
	}

	const suffixPart = `_${suffix}`;
	const room = Math.max(CONFIG_FILENAME_STEM_MAX_LENGTH - suffixPart.length, 1);
	const base = candidate.slice(0, room).replace(/_+$/, '') || fallback;
	return `${base}${suffixPart}`;
}

/**
 * Derives a filesystem-safe key from a name, bounded to the config filename-stem limit with room reserved for a
 * collision suffix, deduplicating against the supplied used-key set and any reserved keys. The chosen key is added
 * to `usedKeys` so a caller can generate a whole batch without repeating one.
 */
export function generateBoundedKey(
	name: string,
	usedKeys: Set<string>,
	options: { fallback: string; reserved?: ReadonlySet<string> }
): string {
	const reserved = options.reserved ?? NO_RESERVED_KEYS;

	let candidate = normalizeConfigKey(name);
	if (candidate === '') candidate = options.fallback;

	let key = boundStem(candidate, options.fallback);
	let suffix = 2;

	while (usedKeys.has(key) || reserved.has(key)) {
		key = boundStem(candidate, options.fallback, suffix);
		suffix++;
	}

	usedKeys.add(key);
	return key;
}
