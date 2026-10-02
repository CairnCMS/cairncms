import type { Api } from './environment';
import type { PrimaryKeyType } from './identities';
import { setupRequest as request } from './request';

export type OptionsCreateRole = {
	name: string;
	appAccessEnabled: boolean;
	adminAccessEnabled: boolean;
};

export async function CreateRole(api: Api, options: OptionsCreateRole) {
	// Action
	const response = await request(api.url)
		.post(`/roles`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send({ name: options.name, app_access: options.appAccessEnabled, admin_access: options.adminAccessEnabled })
		.expect(200);

	return response.body.data;
}

export type OptionsCreateCollection = {
	collection: string;
	meta?: any;
	schema?: any;
	fields?: any;
	// Automatically removed params
	primaryKeyType?: PrimaryKeyType;
};

export async function CreateCollection(api: Api, options: Partial<OptionsCreateCollection>) {
	// Validate options
	if (!options.collection) {
		throw new Error('Missing required field: collection');
	}

	// Parse options
	const defaultOptions = {
		meta: {},
		schema: {},
		fields: [],
		primaryKeyType: 'integer',
	};

	options = Object.assign({}, defaultOptions, options);

	switch (options.primaryKeyType) {
		case 'uuid':
			options.fields.push({
				field: 'id',
				type: 'uuid',
				meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] },
				schema: { is_primary_key: true, length: 36, has_auto_increment: false },
			});

			break;
		case 'string':
			options.fields.push({
				field: 'id',
				type: 'string',
				meta: { hidden: false, readonly: false, interface: 'input' },
				schema: { is_primary_key: true, length: 255, has_auto_increment: false },
			});

			break;
		case 'integer':
		default:
			options.fields.push({
				field: 'id',
				type: 'integer',
				meta: { hidden: true, interface: 'input', readonly: true },
				schema: { is_primary_key: true, has_auto_increment: true },
			});

			break;
	}

	if (options.primaryKeyType) {
		delete options.primaryKeyType;
	}

	// Action
	const response = await request(api.url)
		.post(`/collections`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send(options)
		.expect(200);

	return response.body.data;
}

export type OptionsCreateField = {
	collection: string;
	field: string;
	type: string;
	meta?: any;
	schema?: any;
};

export async function CreateField(api: Api, options: OptionsCreateField) {
	// Parse options
	const defaultOptions = {
		meta: {},
		schema: {},
	};

	options = Object.assign({}, defaultOptions, options);

	// Action
	const response = await request(api.url)
		.post(`/fields/${options.collection}`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send(options)
		.expect(200);

	return response.body.data;
}

export type OptionsCreateRelation = {
	collection: string;
	field: string;
	related_collection: string | null;
	meta?: any;
	schema?: any;
};

export async function CreateRelation(api: Api, options: OptionsCreateRelation) {
	// Parse options
	const defaultOptions = {
		meta: {},
		schema: {},
	};

	options = Object.assign({}, defaultOptions, options);

	// Action
	const response = await request(api.url)
		.post(`/relations`)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.send(options)
		.expect(200);

	return response.body.data;
}

export type OptionsCreateFieldM2O = {
	collection: string;
	field: string;
	fieldMeta?: any;
	fieldSchema?: any;
	primaryKeyType?: PrimaryKeyType;
	otherCollection: string;
	relationMeta?: any;
	relationSchema?: any;
};

export async function CreateFieldM2O(api: Api, options: OptionsCreateFieldM2O) {
	// Parse options
	const defaultOptions = {
		fieldMeta: {},
		fieldSchema: {},
		primaryKeyType: 'integer',
		relationMeta: {},
		relationSchema: {
			on_delete: 'SET NULL',
		},
	};

	options = Object.assign({}, defaultOptions, options);

	const fieldOptions: OptionsCreateField = {
		collection: options.collection,
		field: options.field,
		type: options.primaryKeyType!,
		meta: options.fieldMeta ?? {},
		schema: options.fieldSchema ?? {},
	};

	if (!fieldOptions.meta.special) {
		fieldOptions.meta.special = ['m2o'];
	} else if (!fieldOptions.meta.special.includes('m2o')) {
		fieldOptions.meta.special.push('m2o');
	}

	// Action
	const field = await CreateField(api, fieldOptions);

	const relationOptions: OptionsCreateRelation = {
		collection: options.collection,
		field: options.field,
		meta: options.relationMeta,
		schema: options.relationSchema,
		related_collection: options.otherCollection,
	};

	const relation = await CreateRelation(api, relationOptions);

	return { field, relation };
}

export type OptionsCreateFieldO2M = {
	collection: string;
	field: string;
	fieldMeta?: any;
	otherCollection: string;
	otherField: string;
	primaryKeyType?: string;
	otherMeta?: any;
	otherSchema?: any;
	relationMeta?: any;
	relationSchema?: any;
};

export async function CreateFieldO2M(api: Api, options: OptionsCreateFieldO2M) {
	// Parse options
	const defaultOptions = {
		fieldMeta: {},
		primaryKeyType: 'integer',
		otherMeta: {},
		otherSchema: {},
		relationMeta: {},
		relationSchema: {
			on_delete: 'SET NULL',
		},
	};

	options = Object.assign({}, defaultOptions, options);

	const fieldOptions: OptionsCreateField = {
		collection: options.collection,
		field: options.field,
		type: 'alias',
		meta: options.fieldMeta,
		schema: null,
	};

	if (!fieldOptions.meta.special) {
		fieldOptions.meta.special = ['o2m'];
	} else if (!fieldOptions.meta.special.includes('o2m')) {
		fieldOptions.meta.special.push('o2m');
	}

	// Action
	const field = await CreateField(api, fieldOptions);

	const otherFieldOptions: OptionsCreateField = {
		collection: options.otherCollection,
		field: options.otherField,
		type: options.primaryKeyType!,
		meta: options.otherMeta,
		schema: options.otherSchema,
	};

	const otherField = await CreateField(api, otherFieldOptions);

	const relationOptions: OptionsCreateRelation = {
		collection: options.otherCollection,
		field: options.otherField,
		meta: { ...options.relationMeta, one_field: options.field },
		schema: options.relationSchema,
		related_collection: options.collection,
	};

	const relation = await CreateRelation(api, relationOptions);

	return { field, otherField, relation };
}

export type OptionsCreateFieldM2M = {
	collection: string;
	field: string;
	fieldMeta?: any;
	fieldSchema?: any;
	otherCollection: string;
	otherField: string;
	junctionCollection: string;
	primaryKeyType?: string;
	otherMeta?: any;
	otherSchema?: any;
	relationMeta?: any;
	relationSchema?: any;
	otherRelationSchema?: any;
};

export async function CreateFieldM2M(api: Api, options: OptionsCreateFieldM2M) {
	// Parse options
	const defaultOptions = {
		fieldMeta: {},
		fieldSchema: {},
		primaryKeyType: 'integer',
		otherMeta: {},
		otherSchema: {},
		relationMeta: {},
		relationSchema: {
			on_delete: 'SET NULL',
		},
		otherRelationSchema: {
			on_delete: 'SET NULL',
		},
	};

	options = Object.assign({}, defaultOptions, options);

	const fieldOptions: OptionsCreateField = {
		collection: options.collection,
		field: options.field,
		type: 'alias',
		meta: options.fieldMeta,
		schema: options.fieldSchema,
	};

	const isSelfReferencing = options.collection === options.otherCollection;

	if (!fieldOptions.meta.special) {
		fieldOptions.meta.special = ['m2m'];
	} else if (!fieldOptions.meta.special.includes('m2m')) {
		fieldOptions.meta.special.push('m2m');
	}

	// Action
	const field = await CreateField(api, fieldOptions);

	const otherFieldOptions: OptionsCreateField = {
		collection: options.otherCollection,
		field: options.otherField,
		type: 'alias',
		meta: options.otherMeta,
		schema: options.otherSchema,
	};

	if (!otherFieldOptions.meta.special) {
		otherFieldOptions.meta.special = ['m2m'];
	} else if (!otherFieldOptions.meta.special.includes('m2m')) {
		otherFieldOptions.meta.special.push('m2m');
	}

	const otherField = await CreateField(api, otherFieldOptions);

	const junctionCollectionOptions: OptionsCreateCollection = {
		collection: options.junctionCollection,
		primaryKeyType: 'integer',
	};

	const junctionCollection = await CreateCollection(api, junctionCollectionOptions);

	const junctionFieldName = `${options.collection}_id`;

	const junctionFieldOptions: OptionsCreateField = {
		collection: options.junctionCollection,
		field: junctionFieldName,
		type: options.primaryKeyType!,
	};

	const junctionField = await CreateField(api, junctionFieldOptions);

	const otherJunctionFieldName = `${options.otherCollection}_id${isSelfReferencing ? '2' : ''}`;

	const otherJunctionFieldOptions: OptionsCreateField = {
		collection: options.junctionCollection,
		field: otherJunctionFieldName,
		type: options.primaryKeyType!,
	};

	const otherJunctionField = await CreateField(api, otherJunctionFieldOptions);

	const relationOptions: OptionsCreateRelation = {
		collection: options.junctionCollection,
		field: junctionFieldName,
		meta: {
			...options.relationMeta,
			one_field: options.field,
			junction_field: otherJunctionFieldName,
		},
		schema: options.relationSchema,
		related_collection: options.collection,
	};

	const relation = await CreateRelation(api, relationOptions);

	const otherRelationOptions: OptionsCreateRelation = {
		collection: options.junctionCollection,
		field: otherJunctionFieldName,
		meta: {
			...options.relationMeta,
			one_field: options.otherField,
			junction_field: junctionFieldName,
		},
		schema: options.otherRelationSchema,
		related_collection: options.otherCollection,
	};

	const otherRelation = await CreateRelation(api, otherRelationOptions);

	return { field, otherField, junctionCollection, junctionField, otherJunctionField, relation, otherRelation };
}

export type OptionsCreateFieldM2A = {
	collection: string;
	field: string;
	relatedCollections: string[];
	fieldMeta?: any;
	fieldSchema?: any;
	junctionCollection: string;
	primaryKeyType?: string;
	relationMeta?: any;
	relationSchema?: any;
	itemRelationMeta?: any;
	itemRelationSchema?: any;
};

export async function CreateFieldM2A(api: Api, options: OptionsCreateFieldM2A) {
	// Parse options
	const defaultOptions = {
		fieldMeta: {},
		fieldSchema: {},
		primaryKeyType: 'integer',
		otherMeta: {},
		otherSchema: {},
		relationSchema: null,
		itemRelationSchema: {
			on_delete: 'SET NULL',
		},
	};

	options = Object.assign({}, defaultOptions, options);

	const fieldOptions: OptionsCreateField = {
		collection: options.collection,
		field: options.field,
		type: 'alias',
		meta: options.fieldMeta,
		schema: options.fieldSchema,
	};

	if (!fieldOptions.meta.special) {
		fieldOptions.meta.special = ['m2a'];
	} else if (!fieldOptions.meta.special.includes('m2a')) {
		fieldOptions.meta.special.push('m2a');
	}

	// Action
	const field = await CreateField(api, fieldOptions);

	const junctionCollectionOptions: OptionsCreateCollection = {
		collection: options.junctionCollection,
		primaryKeyType: 'integer',
	};

	const junctionCollection = await CreateCollection(api, junctionCollectionOptions);

	const junctionFieldName = `${options.junctionCollection}_id`;

	const junctionFieldOptions: OptionsCreateField = {
		collection: options.junctionCollection,
		field: junctionFieldName,
		type: options.primaryKeyType!,
		meta: { hidden: true },
	};

	const junctionField = await CreateField(api, junctionFieldOptions);

	const junctionFieldItemOptions: OptionsCreateField = {
		collection: options.junctionCollection,
		field: 'item',
		type: 'string',
		meta: { hidden: true },
	};

	const junctionFieldItem = await CreateField(api, junctionFieldItemOptions);

	const junctionFieldCollectionOptions: OptionsCreateField = {
		collection: options.junctionCollection,
		field: 'collection',
		type: 'string',
		meta: { hidden: true },
	};

	const junctionFieldCollection = await CreateField(api, junctionFieldCollectionOptions);

	const relationOptions: OptionsCreateRelation = {
		collection: options.junctionCollection,
		field: 'item',
		related_collection: null,
		meta: {
			one_allowed_collections: options.relatedCollections,
			one_collection_field: 'collection',
			junction_field: junctionFieldName,
		},
		schema: null,
	};

	const relation = await CreateRelation(api, relationOptions);

	const itemRelationOptions: OptionsCreateRelation = {
		collection: options.junctionCollection,
		field: junctionFieldName,
		related_collection: options.collection,
		meta: {
			one_field: options.field,
			junction_field: 'item',
		},
		schema: options.itemRelationSchema,
	};

	const itemRelation = await CreateRelation(api, itemRelationOptions);

	return {
		field,
		junctionCollection,
		junctionField,
		junctionFieldItem,
		junctionFieldCollection,
		relation,
		otherRelation: itemRelation,
	};
}
