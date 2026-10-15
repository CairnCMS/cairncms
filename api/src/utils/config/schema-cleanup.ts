import type { CairnConfig, ConfigExtensionSettingsAuthored, ConfigPermission, ConfigPlan } from '../../types/config.js';
import type { SnapshotRelation } from '../../types/index.js';

type FieldIdentity = { collection: string; field: string };

/**
 * Applies the configuration effects of the schema plan's drops to the current configuration, as a schema apply leaves
 * it. A dropped collection with a table loses its permissions, every dropped collection loses its collection-scoped
 * extension settings, and a dropped field leaves explicit permission field lists. Dropping a many-to-one field also
 * drops its paired one-to-many alias, as the field service does. A collection drop removes no fields on other
 * collections because the apply deletes the dropped collection's relations before the collection.
 */
export function projectSchemaCleanup(current: CairnConfig, schemaPlan: ConfigPlan['schema']): CairnConfig {
	const dropped = new Set<string>();
	const explicitFields: FieldIdentity[] = [];

	for (const entry of schemaPlan.delete) {
		if (entry.changeKind === 'collections') {
			dropped.add(entry.identity.collection);
		} else if (entry.changeKind === 'fields') {
			explicitFields.push(entry.identity);
		}
	}

	if (dropped.size === 0 && explicitFields.length === 0) return current;

	const remainingRelations = current.schema
		.flatMap((record) => record.relations)
		.filter(
			(relation) =>
				!dropped.has(relation.collection) &&
				(relation.related_collection === null || !dropped.has(relation.related_collection))
		);

	const droppedFields = cascadeFieldDrops(explicitFields, remainingRelations);

	const withTable = new Set(
		current.schema
			.filter((record) => dropped.has(record.collection) && Boolean(record.schema))
			.map((record) => record.collection)
	);

	return {
		...current,
		permissions: current.permissions.map((set) => ({
			...set,
			permissions: set.permissions
				.filter((permission) => !withTable.has(permission.collection))
				.map((permission) => withoutFields(permission, droppedFields.get(permission.collection))),
		})),
		'extension-settings': current['extension-settings'].map((document) => withoutCollections(document, dropped)),
	};
}

/**
 * Mirrors the field service's delete cascade, which drops the paired alias of a many-to-one field unless the relation
 * references its own collection or names the field itself as the alias.
 */
function cascadeFieldDrops(explicitFields: FieldIdentity[], relations: SnapshotRelation[]): Map<string, Set<string>> {
	const droppedFields = new Map<string, Set<string>>();
	const pending = [...explicitFields];

	while (pending.length > 0) {
		const { collection, field } = pending.pop()!;
		const fields = droppedFields.get(collection) ?? new Set<string>();
		if (fields.has(field)) continue;

		fields.add(field);
		droppedFields.set(collection, fields);

		for (const relation of relations) {
			if (relation.collection !== collection || relation.field !== field) continue;

			const related = relation.related_collection;
			const alias = relation.meta?.one_field;

			if (related && alias && related !== collection && alias !== field) {
				pending.push({ collection: related, field: alias });
			}
		}
	}

	return droppedFields;
}

function withoutFields(permission: ConfigPermission, fields: ReadonlySet<string> | undefined): ConfigPermission {
	if (fields === undefined || permission.fields === null || permission.fields.includes('*')) return permission;

	const kept = permission.fields.filter((field) => !fields.has(field));
	if (kept.length === permission.fields.length) return permission;

	return { ...permission, fields: kept.length > 0 ? kept : null };
}

function withoutCollections(
	document: ConfigExtensionSettingsAuthored,
	dropped: ReadonlySet<string>
): ConfigExtensionSettingsAuthored {
	if (document.collections === undefined) return document;

	const kept = Object.entries(document.collections).filter(([collection]) => !dropped.has(collection));
	if (kept.length === Object.keys(document.collections).length) return document;

	return { ...document, collections: Object.fromEntries(kept) };
}
