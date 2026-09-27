import type { Field, Relation } from '@cairncms/types';

type FieldSchema = NonNullable<Field['schema']>;
type FieldRelationMeta = NonNullable<Relation['meta']>;

export function fld(collection: string, name: string, primary = false): Field {
	return {
		collection,
		field: name,
		name,
		type: primary ? 'integer' : 'string',
		schema: primary
			? {
					name,
					table: collection,
					data_type: 'integer',
					default_value: null,
					max_length: null,
					numeric_precision: null,
					numeric_scale: null,
					is_nullable: false,
					is_unique: true,
					is_primary_key: true,
					is_generated: false,
					has_auto_increment: true,
					foreign_key_table: null,
					foreign_key_column: null,
			  }
			: null,
		meta: null,
		children: null,
	};
}

export function rel(
	collection: string,
	field: string,
	related: string | null,
	meta: Partial<NonNullable<Relation['meta']>>
): Relation {
	return {
		collection,
		field,
		related_collection: related,
		schema: null,
		meta: {
			id: 0,
			many_collection: collection,
			many_field: field,
			one_collection: related,
			one_field: null,
			one_collection_field: null,
			one_allowed_collections: null,
			one_deselect_action: 'nullify',
			junction_field: null,
			sort_field: null,
			...meta,
		},
	};
}

export function columnSchema(overrides: Partial<FieldSchema> = {}): FieldSchema {
	return {
		name: '',
		table: '',
		data_type: 'integer',
		default_value: null,
		max_length: null,
		numeric_precision: null,
		numeric_scale: null,
		is_nullable: true,
		is_unique: false,
		is_primary_key: false,
		is_generated: false,
		has_auto_increment: false,
		foreign_key_table: null,
		foreign_key_column: null,
		...overrides,
	};
}

export function field(collection: string, name: string, primary = false, dataType: Field['type'] = 'integer'): Field {
	return {
		collection,
		field: name,
		name,
		type: primary ? dataType : 'string',
		schema: primary ? columnSchema({ is_primary_key: true, data_type: dataType }) : null,
		meta: null,
		children: null,
	};
}

export function relationMeta(overrides: Partial<FieldRelationMeta> = {}): FieldRelationMeta {
	return {
		id: 0,
		many_collection: '',
		many_field: '',
		one_collection: null,
		one_field: null,
		one_collection_field: null,
		one_allowed_collections: null,
		one_deselect_action: 'nullify',
		junction_field: null,
		sort_field: null,
		...overrides,
	};
}

export function relation(partial: {
	collection: string;
	field: string;
	related_collection?: string | null;
	meta?: Partial<FieldRelationMeta>;
}): Relation {
	return {
		collection: partial.collection,
		field: partial.field,
		related_collection: partial.related_collection ?? null,
		schema: null,
		meta: relationMeta(partial.meta),
	};
}
