/**
 * Internal-table classification registry: the single source of truth for which physical
 * tables are Cairn-owned internal platform storage, as opposed to operator data or
 * `directus_*` system tables. A registered internal table is hidden from every
 * schema-enumeration and generic-access surface, deny-by-default and uniformly, with no
 * per-surface opt-in.
 */

const internalTables = new Set<string>(['cairncms_extension_settings']);

export function isInternalTable(collection: string): boolean {
	return internalTables.has(collection);
}

export function getInternalTables(): string[] {
	return [...internalTables];
}

export function registerInternalTable(collection: string): void {
	internalTables.add(collection);
}
