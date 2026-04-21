import type { SchemaOverview } from '@cairncms/types';
import { ForbiddenException } from '../exceptions/forbidden.js';
import type { PrimaryKey } from '../types/index.js';
import { isValidUuid } from './is-valid-uuid.js';

/**
 * Validate keys based on its type
 */
export function validateKeys(
	schema: SchemaOverview,
	collection: string,
	keyField: string,
	keys: PrimaryKey | PrimaryKey[]
) {
	if (Array.isArray(keys)) {
		for (const key of keys) {
			validateKeys(schema, collection, keyField, key);
		}
	} else {
		const primaryKeyFieldType = schema.collections[collection]?.fields[keyField]?.type;

		if (primaryKeyFieldType === 'uuid' && !isValidUuid(String(keys))) {
			throw new ForbiddenException();
		} else if (primaryKeyFieldType === 'integer' && !Number.isInteger(Number(keys))) {
			throw new ForbiddenException();
		}
	}
}
