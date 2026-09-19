import type { ConfigKind, ConfigManifest } from '../../types/config.js';
import type { ConfigReadMode } from './descriptor.js';
import { dependencyClosure, dependencyOrder } from './graph.js';
import { getDescriptor } from './registry.js';

export interface ReadClosureEntry {
	kind: ConfigKind;
	mode: ConfigReadMode;
}

/** Read plan for a manifest: managed kinds read fully, their unmanaged dependencies identity-only, in dependency order. */
export function resolveReadClosure(manifest: ConfigManifest): ReadClosureEntry[] {
	const managed = new Set(manifest.resources);
	const reachable = dependencyClosure(manifest.resources, (kind) => getDescriptor(kind).dependencies);

	return dependencyOrder([...reachable]).map((kind) => ({ kind, mode: managed.has(kind) ? 'full' : 'identity' }));
}

/** Managed kinds to reconcile (plan and apply), in dependency order. Unmanaged dependencies are read, not reconciled. */
export function resolveReconciliation(manifest: ConfigManifest): ConfigKind[] {
	return dependencyOrder(manifest.resources);
}
