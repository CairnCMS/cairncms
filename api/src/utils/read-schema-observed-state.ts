import type { Knex } from 'knex';
import type { SchemaChangeOutcome, SchemaOperation, SchemaPersistedState } from '../types/index.js';

export type FacetApplicability = 'yes' | 'no' | 'unknown';

export type SchemaTouchedCollection = {
	collection: string;
	operation: SchemaOperation;
	table: FacetApplicability;
	metadata: FacetApplicability;
};

export type SchemaTouchedField = {
	collection: string;
	field: string;
	operation: SchemaOperation;
	column: FacetApplicability;
	metadata: FacetApplicability;
};

export type SchemaTouchedRelation = {
	collection: string;
	field: string;
	operation: SchemaOperation;
	metadata: FacetApplicability;
};

export type SchemaTouchedEntities = {
	collections: SchemaTouchedCollection[];
	fields: SchemaTouchedField[];
	relations: SchemaTouchedRelation[];
};

/**
 * Reads the observed state of the entities a schema diff touched, after an apply failed, through a
 * connection outside the dead transaction. On MySQL and MariaDB a data definition statement commits
 * on its own, so a physical table or column can outlive the metadata row a rolled-back statement
 * would have written, or the reverse, and the two exist independently. The caller decides, from the
 * full service write path, whether each facet applies to the change: a facet that does apply is
 * concluded from presence, a facet the write never touches is not_applicable, and a facet the path
 * leaves uncertain stays unknown. An update, and a relation's physical foreign key, are always
 * unknown here. Any read failure propagates, so the caller reports the outcome as unknown.
 */
export async function readSchemaObservedState(
	database: Knex,
	touched: SchemaTouchedEntities
): Promise<SchemaPersistedState> {
	const collections: SchemaPersistedState['collections'] = [];

	for (const { collection, operation, table, metadata } of uniqueCollections(touched.collections)) {
		collections.push({
			collection,
			operation,
			table: await facetOutcome(operation, table, () => database.schema.hasTable(collection)),
			metadata: await facetOutcome(operation, metadata, () =>
				rowExists(database, 'directus_collections', { collection })
			),
		});
	}

	const fields: SchemaPersistedState['fields'] = [];

	for (const { collection, field, operation, column, metadata } of uniqueByField(touched.fields)) {
		fields.push({
			collection,
			field,
			operation,
			column: await facetOutcome(operation, column, async () => {
				if (!(await database.schema.hasTable(collection))) return false;
				return database.schema.hasColumn(collection, field);
			}),
			metadata: await facetOutcome(operation, metadata, () =>
				rowExists(database, 'directus_fields', { collection, field })
			),
		});
	}

	const relations: SchemaPersistedState['relations'] = [];

	for (const { collection, field, operation, metadata } of uniqueByField(touched.relations)) {
		relations.push({
			collection,
			field,
			operation,
			foreignKey: 'unknown',
			metadata: await facetOutcome(operation, metadata, () =>
				rowExists(database, 'directus_relations', { many_collection: collection, many_field: field })
			),
		});
	}

	return { collections, fields, relations };
}

/**
 * True when every facet of the observed state is verified reverted or does not apply, so nothing a
 * touched change would have done is present and nothing is left unverified. An unknown facet keeps
 * the outcome uncertain, since atomicity alone does not establish whether a commit or a rollback ran.
 */
export function schemaStateVerifiedReverted(state: SchemaPersistedState): boolean {
	const outcomes: SchemaChangeOutcome[] = [
		...state.collections.flatMap((entry) => [entry.table, entry.metadata]),
		...state.fields.flatMap((entry) => [entry.column, entry.metadata]),
		...state.relations.flatMap((entry) => [entry.foreignKey, entry.metadata]),
	];

	return outcomes.every((outcome) => outcome === 'reverted' || outcome === 'not_applicable');
}

async function facetOutcome(
	operation: SchemaOperation,
	applicability: FacetApplicability,
	present: () => Promise<boolean>
): Promise<SchemaChangeOutcome> {
	if (operation === 'update') return 'unknown';
	if (applicability === 'unknown') return 'unknown';
	if (applicability === 'no') return 'not_applicable';
	if (operation === 'create') return (await present()) ? 'applied' : 'reverted';
	return (await present()) ? 'reverted' : 'applied';
}

async function rowExists(database: Knex, table: string, where: Record<string, string>): Promise<boolean> {
	const row = await database(table).where(where).first();
	return row !== undefined;
}

function uniqueCollections(entries: SchemaTouchedCollection[]): SchemaTouchedCollection[] {
	const seen = new Set<string>();
	const result: SchemaTouchedCollection[] = [];

	for (const entry of entries) {
		if (seen.has(entry.collection)) continue;
		seen.add(entry.collection);
		result.push(entry);
	}

	return result;
}

function uniqueByField<T extends { collection: string; field: string }>(entries: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];

	for (const entry of entries) {
		const key = `${entry.collection}.${entry.field}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}

	return result;
}
