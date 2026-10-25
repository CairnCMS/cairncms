import { isPlainObject } from 'lodash-es';
import { ALIAS_TYPES } from '../constants.js';

/**
 * Mirrors the column builder: a field writes no column when its type is missing, an alias type, or unknown, and a
 * written column becomes the primary key when it is flagged as one or auto-increments.
 */
export function writesPrimaryKey(type: unknown, schema: unknown): boolean {
	if (typeof type !== 'string' || type === 'unknown' || ALIAS_TYPES.includes(type)) return false;
	if (!isPlainObject(schema)) return false;

	const { is_primary_key, has_auto_increment } = schema as Record<string, unknown>;
	return Boolean(is_primary_key) || Boolean(has_auto_increment);
}
