import { CONFIG_KINDS, type CairnConfig, type ConfigKind, type ConfigManifest } from '../../types/config.js';
import type { ManifestVersion } from '../config-contract.js';
import { kindsForVersion } from './registry.js';

/**
 * Completes a validated wire body into the internal object every kind is present on: each managed kind keeps its
 * records, and every other kind (unmanaged, or absent because it is out of version) becomes an empty array. Runs
 * after validation, so a supplied non-empty unmanaged array is accepted by the validator and emptied here.
 */
export function normalizeToInternal(manifest: ConfigManifest, body: Record<string, unknown>): CairnConfig {
	const managed = new Set<ConfigKind>(manifest.resources);
	const config = { manifest } as CairnConfig;

	for (const kind of CONFIG_KINDS) {
		(config as Record<ConfigKind, unknown[]>)[kind] = managed.has(kind) ? (body[kind] as unknown[]) ?? [] : [];
	}

	return config;
}

/**
 * Projects a complete internal object to the wire shape for a manifest version: kinds not available at that version
 * are dropped. Record contents are left untouched, so malformed values in a local read still reach validation.
 */
export function serializeToWire(config: CairnConfig, version: ManifestVersion): Record<string, unknown> {
	const inVersion = new Set<ConfigKind>(kindsForVersion(version));
	const wire: Record<string, unknown> = { manifest: config.manifest };

	for (const kind of CONFIG_KINDS) {
		if (inVersion.has(kind)) wire[kind] = config[kind];
	}

	return wire;
}
