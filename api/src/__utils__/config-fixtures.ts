import type { CollectionsOverview, FieldOverview, SchemaOverview } from '@cairncms/types';
import type { CairnConfig, ConfigSchemaCollection } from '../types/config.js';
import type { Snapshot, SnapshotField } from '../types/index.js';
import type { ConfigSchemaCapture } from '../utils/get-config-snapshot.js';
import { version } from '../utils/package.js';

export function configFixture(overrides: Partial<CairnConfig> & Pick<CairnConfig, 'manifest'>): CairnConfig {
	return {
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations: [],
		schema: [],
		...overrides,
	};
}

/** One read of the given collections: their config records, stored fields, and the matching snapshot and overview. */
export function schemaReadFixture(records: ConfigSchemaCollection[]): {
	records: ConfigSchemaCollection[];
	storedFields: SnapshotField[];
	capture: ConfigSchemaCapture;
} {
	const storedFields = records.flatMap((record) => record.fields);

	const snapshot: Snapshot = {
		version: 1,
		directus: version,
		collections: records.map(({ collection, meta, schema }) => ({
			collection,
			meta: meta ?? null,
			schema: schema ?? null,
		})),
		fields: storedFields,
		relations: records.flatMap((record) => record.relations),
	};

	const overview: SchemaOverview = {
		collections: Object.fromEntries(records.map((record) => [record.collection, collectionOverview(record)])),
		relations: [],
	};

	return { records, storedFields, capture: { snapshot, overview } };
}

function collectionOverview(record: ConfigSchemaCollection): CollectionsOverview[string] {
	const columns = record.fields.filter((field) => field.schema != null);

	return {
		collection: record.collection,
		primary: columns.find((field) => field.schema?.is_primary_key)?.field ?? '',
		singleton: false,
		sortField: null,
		note: null,
		accountability: 'all',
		fields: Object.fromEntries(columns.map((field) => [field.field, fieldOverview(field)])),
	};
}

function fieldOverview(field: SnapshotField): FieldOverview {
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
		alias: false,
	};
}
