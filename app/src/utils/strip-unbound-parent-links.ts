import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import { isPlainObject } from 'lodash';

const NEW_ITEM_MARKER = '+';

type Stores = {
	relationsStore: ReturnType<typeof useRelationsStore>;
	fieldsStore: ReturnType<typeof useFieldsStore>;
};

type ChildrenRelation = {
	kind: 'children';
	reverseField: string;
	entryCollection: string;
};

type NestedRelation = {
	kind: 'nested';
	relatedCollection: string | null;
	discriminatorField: string | null;
};

type ResolvedRelation = ChildrenRelation | NestedRelation | null;

export function stripUnboundParentLinks(collection: string, payload: unknown, parentIsBound: boolean): any {
	if (!isPlainObject(payload)) return payload;

	const stores: Stores = {
		relationsStore: useRelationsStore(),
		fieldsStore: useFieldsStore(),
	};

	return cleanItem(collection, payload as Record<string, any>, parentIsBound, stores);
}

function cleanItem(
	collection: string,
	item: Record<string, any>,
	isBound: boolean,
	stores: Stores
): Record<string, any> {
	const result: Record<string, any> = {};

	for (const [field, value] of Object.entries(item)) {
		const relation = resolveRelationField(collection, field, stores);

		if (relation?.kind === 'children') {
			result[field] = cleanChildren(value, relation, isBound, stores);
		} else if (relation?.kind === 'nested') {
			result[field] = cleanNested(collection, item, value, relation, stores);
		} else {
			result[field] = value;
		}
	}

	return result;
}

function cleanChildren(value: any, relation: ChildrenRelation, parentIsBound: boolean, stores: Stores): any {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			isPlainObject(entry)
				? cleanEntry(entry, relation, parentIsBound, isBoundItem(relation.entryCollection, entry, stores), stores)
				: entry
		);
	}

	if (isPlainObject(value)) {
		const staged = value as Record<string, any>;
		const result: Record<string, any> = { ...staged };

		if (Array.isArray(staged.create)) {
			result.create = staged.create.map((entry: any) =>
				isPlainObject(entry) ? cleanEntry(entry, relation, parentIsBound, false, stores) : entry
			);
		}

		if (Array.isArray(staged.update)) {
			result.update = staged.update.map((entry: any) =>
				isPlainObject(entry) ? cleanEntry(entry, relation, parentIsBound, true, stores) : entry
			);
		}

		return result;
	}

	return value;
}

function cleanEntry(
	entry: Record<string, any>,
	relation: ChildrenRelation,
	parentIsBound: boolean,
	entryIsBound: boolean,
	stores: Stores
): Record<string, any> {
	const copy: Record<string, any> = { ...entry };

	if (!parentIsBound && copy[relation.reverseField] === NEW_ITEM_MARKER) {
		delete copy[relation.reverseField];
	}

	return cleanItem(relation.entryCollection, copy, entryIsBound, stores);
}

function cleanNested(
	parentCollection: string,
	parent: Record<string, any>,
	value: any,
	relation: NestedRelation,
	stores: Stores
): any {
	if (!isPlainObject(value)) return value;

	const targetCollection = relation.discriminatorField
		? (parent[relation.discriminatorField] as string | undefined)
		: relation.relatedCollection;

	if (!targetCollection) return value;

	const nested = value as Record<string, any>;
	const bound = isBoundItem(targetCollection, nested, stores);

	return cleanItem(targetCollection, nested, bound, stores);
}

function isBoundItem(collection: string, item: Record<string, any>, stores: Stores): boolean {
	const pkField = stores.fieldsStore.getPrimaryKeyFieldForCollection(collection)?.field;
	if (!pkField) return true;

	const pk = item[pkField];

	return pk !== undefined && pk !== null;
}

function resolveRelationField(collection: string, field: string, stores: Stores): ResolvedRelation {
	const relations = stores.relationsStore.getRelationsForField(collection, field) ?? [];
	if (relations.length === 0) return null;

	const alias = relations.find(
		(relation) => relation.related_collection === collection && relation.meta?.one_field === field
	);

	if (alias) {
		if (alias.meta?.junction_field) {
			const junctionToRelated = relations.find(
				(relation) => relation.collection === alias.collection && relation.field === alias.meta?.junction_field
			);

			const reverseField = junctionToRelated?.meta?.junction_field;
			if (!reverseField) return null;

			return { kind: 'children', reverseField, entryCollection: alias.collection };
		}

		const reverseField = alias.meta?.many_field ?? alias.field;

		return { kind: 'children', reverseField, entryCollection: alias.collection };
	}

	const foreignKey = relations.find((relation) => relation.collection === collection && relation.field === field);

	if (foreignKey) {
		if (foreignKey.meta?.one_collection_field && foreignKey.meta?.one_allowed_collections) {
			return { kind: 'nested', relatedCollection: null, discriminatorField: foreignKey.meta.one_collection_field };
		}

		return { kind: 'nested', relatedCollection: foreignKey.related_collection ?? null, discriminatorField: null };
	}

	return null;
}
