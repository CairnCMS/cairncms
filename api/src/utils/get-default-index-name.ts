import { getSimpleHash } from '@cairncms/utils';
/**
 * Generate an index name for a given collection + fields combination.
 *
 * Based on knex's default index name generation, but capped at 64 characters
 * (the max length for MySQL and MariaDB).
 */
export function getDefaultIndexName(
	type: 'unique' | 'foreign' | 'index',
	collection: string,
	fields: string | string[]
): string {
	if (!Array.isArray(fields)) fields = fields ? [fields] : [];
	const table = collection.replace(/\.|-/g, '_');
	const indexName = (table + '_' + fields.join('_') + '_' + type).toLowerCase();

	if (indexName.length <= 60) return indexName;

	const suffix = `__${getSimpleHash(indexName)}_${type}`;
	const prefix = indexName.substring(0, 60 - suffix.length);

	return `${prefix}${suffix}`;
}
