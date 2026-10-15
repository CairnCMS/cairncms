import type { Field, FieldOverview, Relation, SchemaOverview } from '@cairncms/types';
import type { Diff, DiffNew } from 'deep-diff';
import deepDiff from 'deep-diff';
import { cloneDeep } from 'lodash-es';
import { ALIAS_TYPES } from '../constants.js';
import type { Collection, Snapshot, SnapshotDiff, SnapshotField, SnapshotRelation } from '../types/index.js';
import { DiffKind } from '../types/index.js';
import { isNestedMetaUpdate } from './is-nested-meta-update.js';
import { collectionDeleteOrder } from './schema-collection-order.js';
import {
	assertAliasTypeUnchanged,
	assertCollectionAbsent,
	assertCollectionAttributesKept,
	assertCollectionNameAllowed,
	assertCollectionPresent,
	assertFieldAbsent,
	assertFieldTypeIsSupported,
	assertRelationCreatable,
	assertRelationModifiable,
} from './schema-diff-validators.js';

/**
 * Evaluates the deterministic schema-apply refusals over the whole diff against the transaction-bound
 * state before the first write, so a plan a later step would reject cannot leave an earlier step
 * committed where data definition changes commit implicitly. It walks the diff in the write order of
 * `applyDiff` and reproduces the state each write service reads: the collection services read an
 * evolving view, while the field and relation services each read a schema captured once at the start
 * of their phase (`applyDiff` re-reads it via `getSchema` after collections and after fields). It
 * propagates the same refusals the services raise. Runtime database failures and hook-mutated payloads
 * are out of scope and fall to the observed-state reporting.
 */
export function assertSchemaDiffApplicable(
	snapshotDiff: SnapshotDiff,
	currentSnapshot: Snapshot,
	schema: SchemaOverview
): void {
	const work = cloneDeep(schema);
	const reservedNames = new Set(currentSnapshot.collections.map((collection) => collection.collection));
	const fieldRows = new Set(currentSnapshot.fields.map((field) => `${field.collection}.${field.field}`));
	const createdCollections = new Set<string>();
	const deletedFields = new Set<string>();

	const nestedCreates = (parent: string): SnapshotDiff['collections'] =>
		snapshotDiff.collections.filter(({ diff }) => (diff[0] as DiffNew<Collection>).rhs?.meta?.group === parent);

	const projectCollectionCreate = (collections: SnapshotDiff['collections']): void => {
		for (const { collection, diff } of collections) {
			if (diff[0]?.kind !== DiffKind.NEW || isNestedMetaUpdate(diff[0])) continue;

			const created = (diff[0] as DiffNew<Collection>).rhs;
			if (!created) continue;

			assertCollectionNameAllowed(collection);
			assertCollectionAbsent(collection, reservedNames);

			const embedded = snapshotDiff.fields
				.filter((fieldDiff) => fieldDiff.collection === collection)
				.map((fieldDiff) => (fieldDiff.diff[0] as DiffNew<SnapshotField>).rhs)
				.filter((field): field is SnapshotField => field !== undefined);

			if (created.schema) {
				const fields: Record<string, FieldOverview> = {};
				let primary = '';

				for (const field of embedded) {
					if (field.type && ALIAS_TYPES.includes(field.type) === false) {
						assertFieldTypeIsSupported(field);
					}

					if (isRuntimeVisible(field)) fields[field.field] = toFieldOverview(field);
					if (field.schema?.is_primary_key) primary = field.field;
					fieldRows.add(`${collection}.${field.field}`);
				}

				work.collections[collection] = {
					collection,
					primary,
					singleton: false,
					sortField: null,
					note: null,
					accountability: 'all',
					fields,
				};
			}

			reservedNames.add(collection);
			createdCollections.add(collection);

			projectCollectionCreate(nestedCreates(collection));
		}
	};

	const projectCollectionDelete = (collection: string): void => {
		const touching = work.relations.filter(
			(relation) => relation.related_collection === collection || relation.collection === collection
		);

		for (const relation of touching) {
			assertRelationModifiable(relation.collection, relation.field, work);
		}

		work.relations = work.relations.filter(
			(relation) => relation.related_collection !== collection && relation.collection !== collection
		);

		assertCollectionPresent(collection, reservedNames);

		reservedNames.delete(collection);
		delete work.collections[collection];

		for (const key of fieldRows) {
			if (key.startsWith(`${collection}.`)) fieldRows.delete(key);
		}
	};

	projectCollectionCreate(
		snapshotDiff.collections.filter(({ diff }) => {
			if (diff[0]?.kind !== DiffKind.NEW || isNestedMetaUpdate(diff[0])) return false;

			const group = (diff[0] as DiffNew<Collection>).rhs.meta?.group;
			if (!group) return true;

			const parentExists = currentSnapshot.collections.some((collection) => collection.collection === group);

			const parentWillBeCreated = snapshotDiff.collections.some(
				({ collection, diff: parentDiff }) =>
					parentDiff[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(parentDiff[0]) && collection === group
			);

			return parentExists && !parentWillBeCreated;
		})
	);

	for (const collection of collectionDeleteOrder(snapshotDiff)) projectCollectionDelete(collection);

	for (const { collection, diff } of snapshotDiff.collections) assertCollectionAttributesKept(collection, diff);

	// The field services read a schema captured once after the collection phase, so the field loop
	// evaluates its guards against this frozen view while projecting each write's effect forward into
	// the relation-phase view the relation services will read.
	const fieldPhase = cloneDeep(work);
	const relationPhase = cloneDeep(work);
	dropIneligibleCollections(fieldPhase);

	const projectFieldDelete = (collection: string, field: string): void => {
		const relations = fieldPhase.relations.filter(
			(relation) =>
				(relation.collection === collection && relation.field === field) ||
				(relation.related_collection === collection && relation.meta?.one_field === field)
		);

		for (const relation of relations) {
			const isM2O = relation.collection === collection && relation.field === field;

			if (isM2O) {
				relationPhase.relations = relationPhase.relations.filter(
					(existing) => (existing.collection === relation.collection && existing.field === relation.field) === false
				);

				if (
					relation.related_collection &&
					relation.meta?.one_field &&
					relation.related_collection !== collection &&
					relation.meta.one_field !== field
				) {
					delete relationPhase.collections[relation.related_collection]?.fields[relation.meta.one_field];
					fieldRows.delete(`${relation.related_collection}.${relation.meta.one_field}`);
				}
			} else {
				const kept = relationPhase.relations.find(
					(existing) => existing.collection === relation.collection && existing.field === relation.field
				);

				if (kept?.meta) kept.meta.one_field = null;
			}
		}

		const target = relationPhase.collections[collection];

		if (target) {
			delete target.fields[field];
			if (target.primary === field) target.primary = '';
		}

		fieldRows.delete(`${collection}.${field}`);
	};

	for (const { collection, field, diff } of snapshotDiff.fields) {
		if (createdCollections.has(collection)) continue;

		if (diff[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff[0])) {
			const frozen = fieldPhase.collections[collection];
			if (!frozen) continue;

			const incoming = (diff[0] as DiffNew<SnapshotField>).rhs;
			const exists = field in frozen.fields || fieldRows.has(`${collection}.${field}`);
			assertFieldAbsent(collection, field, exists);

			if (incoming.type && ALIAS_TYPES.includes(incoming.type) === false) {
				assertFieldTypeIsSupported(incoming);
			}

			const target = relationPhase.collections[collection]!;
			if (isRuntimeVisible(incoming)) target.fields[field] = toFieldOverview(incoming);
			if (incoming.schema?.is_primary_key) target.primary = field;
			fieldRows.add(`${collection}.${field}`);
		}

		if (isFieldUpdate(diff)) {
			const frozen = fieldPhase.collections[collection];

			const current = currentSnapshot.fields.find(
				(snapshotField) => snapshotField.collection === collection && snapshotField.field === field
			);

			if (frozen && current) {
				const incoming = rebuildField(current, diff);
				assertAliasTypeUnchanged(incoming.type, frozen.fields[field]?.type);

				if (incoming.schema && incoming.type !== 'alias' && incoming.type !== 'unknown') {
					assertFieldTypeIsSupported(incoming);
				}

				const target = relationPhase.collections[collection];

				if (target) {
					if (isRuntimeVisible(incoming)) target.fields[field] = toFieldOverview(incoming);
					else delete target.fields[field];
					if (incoming.schema?.is_primary_key) target.primary = field;
				}
			}
		}

		if (diff[0]?.kind === DiffKind.DELETE && !isNestedMetaUpdate(diff[0])) {
			projectFieldDelete(collection, field);
			deletedFields.add(`${collection}.${field}`);
		}
	}

	dropIneligibleCollections(relationPhase);

	for (const { collection, field, diff } of snapshotDiff.relations) {
		if (deletedFields.has(`${collection}.${field}`)) continue;

		if (diff[0]?.kind === DiffKind.NEW) {
			const incoming = { ...(diff[0] as DiffNew<SnapshotRelation>).rhs, collection, field } as Relation;
			assertRelationCreatable(incoming, relationPhase);
		}

		if (diff[0]?.kind === DiffKind.EDIT || diff[0]?.kind === DiffKind.ARRAY) {
			const current = currentSnapshot.relations.find(
				(relation) => relation.collection === collection && relation.field === field
			);

			if (current) assertRelationModifiable(collection, field, relationPhase);
		}

		if (diff[0]?.kind === DiffKind.DELETE) {
			assertRelationModifiable(collection, field, relationPhase);
		}
	}
}

/**
 * Mirrors `getSchema`: a collection without a primary key column is not a runtime collection, so it
 * drops out of the view the relation guards read once a field change removes its last primary key.
 */
function dropIneligibleCollections(overview: SchemaOverview): void {
	for (const name of Object.keys(overview.collections)) {
		if (!overview.collections[name]!.primary) delete overview.collections[name];
	}
}

function isFieldUpdate(diff: Diff<SnapshotField | undefined>[]): boolean {
	return diff[0]?.kind === DiffKind.EDIT || diff[0]?.kind === DiffKind.ARRAY || isNestedMetaUpdate(diff[0]);
}

function rebuildField(current: SnapshotField, diff: Diff<SnapshotField | undefined>[]): SnapshotField {
	return diff.reduce((accumulator, change) => {
		deepDiff.applyChange(accumulator, undefined, change);
		return accumulator;
	}, cloneDeep(current));
}

/**
 * Mirrors `getSchema`: a backing column always reaches the runtime schema, since the column pass runs
 * before the metadata overlay. A metadata-only field reaches it only through an alias special, and
 * no-data hides that overlay but never a column.
 */
function isRuntimeVisible(field: SnapshotField | Field): boolean {
	if (field.schema != null) return true;
	const special = field.meta?.special ?? [];
	if (special.includes('no-data')) return false;
	return special.some((entry) => ALIAS_TYPES.includes(entry));
}

function toFieldOverview(field: Field): FieldOverview {
	return {
		field: field.field,
		type: field.type ?? 'unknown',
		defaultValue: field.schema?.default_value ?? null,
		nullable: field.schema?.is_nullable ?? true,
		generated: field.schema?.is_generated ?? false,
		dbType: field.schema?.data_type ?? null,
		precision: field.schema?.numeric_precision ?? null,
		scale: field.schema?.numeric_scale ?? null,
		special: field.meta?.special ?? [],
		note: field.meta?.note ?? null,
		validation: field.meta?.validation ?? null,
		alias: field.type ? ALIAS_TYPES.includes(field.type) : false,
	};
}
