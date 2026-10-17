import { KNEX_TYPES } from '@cairncms/constants';
import type { Field, RawField, Relation, SchemaOverview } from '@cairncms/types';
import type { Diff } from 'deep-diff';
import { get } from 'lodash-es';
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

		if (!removesValue(change)) continue;

		throw new InvalidPayloadException(
			attribute === 'schema'
				? `Collection "${collection}" can't remove its table and remain as a collection.`
				: `Collection "${collection}" can't remove its collection metadata.`
		);
	}
}

/**
 * The field services change a column, type, or metadata row only when given one, and rebuild a kept column from the
 * whole column definition with defaults for what it leaves out. So a kept field can't remove one of those attributes,
 * gain a column, or omit a property from its column definition. Removing an attribute that is already null passes.
 */
export function assertFieldAttributesKept(collection: string, field: string, changes: readonly Diff<unknown>[]): void {
	const name = `${collection}.${field}`;

	for (const change of changes) {
		const [attribute, property] = change.path ?? [];

		if (change.path?.length === 2 && attribute === 'schema' && change.kind === DiffKind.DELETE) {
			throw new InvalidPayloadException(
				`Field "${name}" can't omit "schema.${String(property)}" from its column definition.`
			);
		}

		if (change.path?.length !== 1) continue;

		if (attribute === 'schema' && addsValue(change)) {
			throw new InvalidPayloadException(`Field "${name}" can't add a column to an existing field.`);
		}

		if (!removesValue(change)) continue;

		if (attribute === 'schema') {
			throw new InvalidPayloadException(`Field "${name}" can't remove its column and remain as a field.`);
		}

		if (attribute === 'meta') {
			throw new InvalidPayloadException(`Field "${name}" can't remove its field metadata.`);
		}

		if (attribute === 'type') {
			throw new InvalidPayloadException(`Field "${name}" can't remove its type.`);
		}
	}
}

/**
 * The relation services keep a foreign key or metadata row unless given a replacement, so a kept relation can't
 * remove either attribute. Removing metadata that is already null changes nothing and passes.
 */
export function assertRelationAttributesKept(
	collection: string,
	field: string,
	changes: readonly Diff<unknown>[]
): void {
	for (const change of changes) {
		if (change.path?.length !== 1 || !removesValue(change)) continue;

		const attribute = change.path[0];

		if (attribute === 'schema') {
			throw new InvalidPayloadException(
				`Relation "${collection}.${field}" can't remove its foreign key and remain as a relation.`
			);
		}

		if (attribute === 'meta') {
			throw new InvalidPayloadException(`Relation "${collection}.${field}" can't remove its relation metadata.`);
		}
	}
}

const RELATION_TARGET_PATHS = [
	'related_collection',
	'meta.one_collection',
	'schema.foreign_key_table',
	'schema.foreign_key_column',
] as const;

const RELATION_OWNER_PATHS = ['meta.many_collection', 'meta.many_field', 'schema.table', 'schema.column'] as const;

type RelationConnection = Pick<Relation, 'collection' | 'field' | 'related_collection' | 'meta' | 'schema'>;

/**
 * Updating a relation re-adds its foreign key on the relation's own field against its current target, while writing
 * the given metadata as is. So a kept relation can't change what it connects, and metadata or a foreign key it gains
 * must describe the connection it already has, keyed to the target's primary key in the given view.
 */
export function assertRelationConnectionKept(
	current: RelationConnection,
	incoming: Pick<Relation, 'related_collection' | 'meta' | 'schema'>,
	relatedPrimary: string | undefined
): void {
	const { collection, field, related_collection: related } = current;

	const gained: Record<string, unknown> = {
		'meta.one_collection': related,
		'meta.many_collection': collection,
		'meta.many_field': field,
		'schema.foreign_key_table': related,
		'schema.foreign_key_column': relatedPrimary,
		'schema.table': collection,
		'schema.column': field,
	};

	const changed = (path: string): boolean => {
		const [attribute] = path.split('.');

		if (attribute === 'meta' || attribute === 'schema') {
			if (incoming[attribute] == null) return false;
			const before = current[attribute] != null ? get(current, path) : gained[path];
			return (get(incoming, path) ?? null) !== (before ?? null);
		}

		return (get(incoming, path) ?? null) !== (get(current, path) ?? null);
	};

	if (RELATION_TARGET_PATHS.some(changed)) {
		throw new InvalidPayloadException(`Relation "${collection}.${field}" can't change its related collection.`);
	}

	if (RELATION_OWNER_PATHS.some(changed)) {
		throw new InvalidPayloadException(`Relation "${collection}.${field}" can't change the field it belongs to.`);
	}
}

function removesValue(change: Diff<unknown>): boolean {
	return (
		(change.kind === DiffKind.DELETE && change.lhs != null) ||
		(change.kind === DiffKind.EDIT && change.lhs != null && change.rhs == null)
	);
}

function addsValue(change: Diff<unknown>): boolean {
	return (
		(change.kind === DiffKind.NEW && change.rhs != null) ||
		(change.kind === DiffKind.EDIT && change.lhs == null && change.rhs != null)
	);
}

/** A collection's group references a collection metadata row, which must exist when the collection is created. */
export function assertCollectionGroupHasMetadata(collection: string, group: string, hasMetadata: boolean): void {
	if (!hasMetadata) {
		throw new InvalidPayloadException(
			`Collection "${collection}" can't be grouped under "${group}", which has no collection metadata.`
		);
	}
}

export function assertCollectionGroupAcyclic(collection: string, inCycle: boolean): void {
	if (inCycle) {
		throw new InvalidPayloadException(
			`Collection "${collection}" can't be grouped under itself through a group cycle.`
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
