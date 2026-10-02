import type { Knex } from 'knex';
import { isValidUuid } from '../is-valid-uuid.js';

/**
 * True when a value is shaped like a folder id. Folder ids are UUIDs, so an arbitrary stored value such
 * as an interface option's non-folder string can be rejected before it reaches a uuid column, where a
 * malformed value would raise a database error rather than simply not matching.
 */
export function isFolderId(value: unknown): value is string {
	return typeof value === 'string' && isValidUuid(value);
}

/**
 * Resolves a folder id reference to a mapped value. An exact match is authoritative. A differently cased
 * spelling, which a case-insensitive database permits between a foreign key and the id it points at, is
 * confirmed through the supplied database using the raw reference, so the database decides which row the
 * reference denotes and a distinct row on a case-sensitive database is never invented as a match. A
 * non-uuid or unmatched reference resolves to undefined without folding case in memory, preserving the
 * caller's missing-reference path.
 */
export async function resolveFolderReference<V>(
	database: Knex,
	exact: ReadonlyMap<string, V>,
	rawId: unknown
): Promise<V | undefined> {
	if (typeof rawId !== 'string') return undefined;
	if (exact.has(rawId)) return exact.get(rawId);
	if (!isFolderId(rawId)) return undefined;

	const row = await database.select('id').from('directus_folders').where('id', rawId).first();
	if (!row) return undefined;

	return exact.get(String(row['id']));
}
