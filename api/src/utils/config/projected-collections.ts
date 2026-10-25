import type { SchemaOverview } from '@cairncms/types';
import { toArray } from '@cairncms/utils';
import { isPlainObject } from 'lodash-es';
import { isInternalTable } from '../../database/internal-tables.js';
import env from '../../env.js';
import type { ConfigPlan } from '../../types/config.js';
import { writesPrimaryKey } from '../writes-primary-key.js';

/**
 * Projects the collections `getSchema` admits once the schema plan applies. A dropped collection leaves. A collection
 * whose primary key field is dropped leaves unless another of its fields writes a primary key column. A created
 * collection joins only with a table, a field that writes its primary key column, and a name `getSchema` keeps.
 */
export function projectCollections(
	current: SchemaOverview['collections'],
	schemaPlan: ConfigPlan['schema']
): Set<string> {
	const keyed = new Set<string>();

	for (const entry of [...schemaPlan.create, ...schemaPlan.update]) {
		if (entry.changeKind !== 'fields') continue;

		const { collection, field } = entry.identity;
		const type = entry.changes['type'] ? entry.changes['type'].after : liveType(current, collection, field);

		if (writesPrimaryKey(type, entry.changes['schema']?.after)) keyed.add(collection);
	}

	const collections = new Set(Object.keys(current));

	for (const entry of schemaPlan.delete) {
		const { collection } = entry.identity;

		if (entry.changeKind === 'collections') {
			collections.delete(collection);
		} else if (
			entry.changeKind === 'fields' &&
			current[collection]?.primary === entry.identity.field &&
			!keyed.has(collection)
		) {
			collections.delete(collection);
		}
	}

	for (const entry of schemaPlan.create) {
		const { collection } = entry.identity;

		if (
			entry.changeKind === 'collections' &&
			isPlainObject(entry.changes['schema']?.after) &&
			keyed.has(collection) &&
			isAdmittedName(collection)
		) {
			collections.add(collection);
		}
	}

	return collections;
}

function liveType(current: SchemaOverview['collections'], collection: string, field: string): string | undefined {
	if (!Object.hasOwn(current, collection)) return undefined;

	const fields = current[collection]!.fields;
	return Object.hasOwn(fields, field) ? fields[field]!.type : undefined;
}

function isAdmittedName(collection: string): boolean {
	return (
		!isInternalTable(collection) && !toArray(env['DB_EXCLUDE_TABLES']).includes(collection) && !collection.includes(' ')
	);
}
