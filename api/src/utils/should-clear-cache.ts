import type Keyv from 'keyv';
import { getEnv } from '../env.js';
import type { MutationOptions } from '../types/items.js';

export function shouldClearCache(
	cache: Keyv<any> | null,
	opts?: MutationOptions,
	collection?: string
): cache is Keyv<any> {
	const env = getEnv();

	if (env['CACHE_AUTO_PURGE']) {
		if (collection && env['CACHE_AUTO_PURGE_IGNORE_LIST'].includes(collection)) {
			return false;
		}

		if (cache && opts?.autoPurgeCache !== false) {
			return true;
		}
	}

	return false;
}
