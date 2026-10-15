import { KNEX_TYPES } from '@cairncms/constants';
import type { Field, RawField, Relation, SchemaOverview } from '@cairncms/types';
import type { Diff } from 'deep-diff';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { DiffKind } from '../types/index.js';

/**
 * Deterministic schema-apply refusals shared by the write services and the apply preflight, so a plan
 * that both would reject is rejected before any write. Authorization is deliberately excluded: it stays
 * at each request boundary and is not re-evaluated here.
 */

export function assertCollectionNameAllowed(collection: string | undefined): asserts collection is string {
	if (!collection) throw new InvalidPayloadException(`"collection" is required`);

	if (collection.startsWith('directus_')) {
		throw new InvalidPayloadException(`Collections can't start with "directus_"`);
	}
}

export function assertCollectionAbsent(collection: string, existingCollections: ReadonlySet<string>): void {
	if (existingCollections.has(collection)) {
		throw new InvalidPayloadException(`Collection "${collection}" already exists.`);
	}
}

export function assertCollectionPresent(collection: string, existingCollections: ReadonlySet<string>): void {
	// The delete path reports a missing collection as forbidden rather than not-found; preserve that.
	if (existingCollections.has(collection) === false) {
		throw new ForbiddenException();
	}
}

/**
 * The collection services cannot drop a kept collection's table or remove its metadata row, so a change that removes
 * either attribute whole is refused. Removing metadata that is already null changes nothing and passes.
 */
export function assertCollectionAttributesKept(collection: string, changes: readonly Diff<unknown>[]): void {
	for (const change of changes) {
		if (change.path?.length !== 1) continue;

		const attribute = change.path[0];
		if (attribute !== 'schema' && attribute !== 'meta') continue;

		const removed =
			(change.kind === DiffKind.DELETE && change.lhs != null) ||
			(change.kind === DiffKind.EDIT && change.lhs != null && change.rhs == null);

		if (!removed) continue;

		throw new InvalidPayloadException(
			attribute === 'schema'
				? `Collection "${collection}" can't remove its table and remain as a collection.`
				: `Collection "${collection}" can't remove its collection metadata.`
		);
	}
}

export function assertFieldAbsent(collection: string, field: string, exists: boolean): void {
	if (exists) {
		throw new InvalidPayloadException(`Field "${field}" already exists in collection "${collection}"`);
	}
}

export function assertAliasTypeUnchanged(
	incomingType: string | null | undefined,
	currentType: string | undefined
): void {
	if (
		incomingType &&
		(incomingType === 'alias' || currentType === 'alias') &&
		incomingType !== (currentType ?? 'alias')
	) {
		throw new InvalidPayloadException('Alias type cannot be changed');
	}
}

export function assertFieldTypeIsSupported(field: Pick<RawField | Field, 'type' | 'schema'>): void {
	const type = field.type;

	if (type === 'alias' || type === 'unknown') return;
	if (field.schema?.has_auto_increment) return;

	if (
		type === 'string' ||
		type === 'csv' ||
		type === 'hash' ||
		type === 'dateTime' ||
		type === 'timestamp' ||
		type === 'float' ||
		type === 'decimal' ||
		type.startsWith('geometry') ||
		KNEX_TYPES.includes(type as (typeof KNEX_TYPES)[number])
	) {
		return;
	}

	throw new InvalidPayloadException(`Illegal type passed: "${type}"`);
}

export function assertRelationCreatable(relation: Partial<Relation>, schema: SchemaOverview): void {
	if (!relation.collection) throw new InvalidPayloadException('"collection" is required');
	if (!relation.field) throw new InvalidPayloadException('"field" is required');

	if (relation.collection in schema.collections === false) {
		throw new InvalidPayloadException(`Collection "${relation.collection}" doesn't exist`);
	}

	if (relation.field in schema.collections[relation.collection]!.fields === false) {
		throw new InvalidPayloadException(`Field "${relation.field}" doesn't exist in collection "${relation.collection}"`);
	}

	// A primary key should not be a foreign key
	if (schema.collections[relation.collection]!.primary === relation.field) {
		throw new InvalidPayloadException(
			`Field "${relation.field}" in collection "${relation.collection}" is a primary key`
		);
	}

	if (relation.related_collection && relation.related_collection in schema.collections === false) {
		throw new InvalidPayloadException(`Collection "${relation.related_collection}" doesn't exist`);
	}

	const existingRelation = schema.relations.find(
		(existing) => existing.collection === relation.collection && existing.field === relation.field
	);

	if (existingRelation) {
		throw new InvalidPayloadException(
			`Field "${relation.field}" in collection "${relation.collection}" already has an associated relationship`
		);
	}
}

export function assertRelationModifiable(collection: string, field: string, schema: SchemaOverview): void {
	if (collection in schema.collections === false) {
		throw new InvalidPayloadException(`Collection "${collection}" doesn't exist`);
	}

	if (field in schema.collections[collection]!.fields === false) {
		throw new InvalidPayloadException(`Field "${field}" doesn't exist in collection "${collection}"`);
	}

	const existingRelation = schema.relations.find(
		(existing) => existing.collection === collection && existing.field === field
	);

	if (!existingRelation) {
		throw new InvalidPayloadException(`Field "${field}" in collection "${collection}" doesn't have a relationship.`);
	}
}
