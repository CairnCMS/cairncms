import { normalizeRoleKey } from '@cairncms/utils';
import Joi from 'joi';
import type { ConfigDocumentShape, ConfigFieldDescriptor } from './descriptor.js';

const ROLE_KEY_GRAMMAR_MESSAGE =
	'{{#label}} must be lowercase alphanumeric with underscores, and cannot start with a digit or underscore.';

const ROLE_KEY_RESERVED_MESSAGE = '{{#label}} is reserved for public permissions and cannot name a role.';

function buildRoleKeyBase(field: ConfigFieldDescriptor): Joi.Schema {
	let schema = Joi.string();
	if (field.minLength !== undefined) schema = schema.min(field.minLength);
	if (field.maxLength !== undefined) schema = schema.max(field.maxLength);

	schema = schema
		.custom((value, helpers) => (normalizeRoleKey(value) === value ? value : helpers.error('roleKey.grammar')))
		.messages({ 'roleKey.grammar': ROLE_KEY_GRAMMAR_MESSAGE });

	if (field.reserved && field.reserved.length > 0) {
		schema = schema.invalid(...field.reserved).messages({ 'any.invalid': ROLE_KEY_RESERVED_MESSAGE });
	}

	return schema;
}

function buildStringBase(field: ConfigFieldDescriptor): Joi.Schema {
	if (field.enum) return Joi.string().valid(...field.enum);

	let schema = Joi.string();
	if (field.allowEmpty) schema = schema.allow('');
	if (field.minLength !== undefined) schema = schema.min(field.minLength);
	if (field.maxLength !== undefined) schema = schema.max(field.maxLength);
	return schema;
}

function buildBase(field: ConfigFieldDescriptor): Joi.Schema {
	if (field.grammar === 'role-key') return buildRoleKeyBase(field);

	switch (field.type) {
		case 'boolean':
			return Joi.boolean();
		case 'string-list':
			return Joi.array().items(field.allowEmptyElements ? Joi.string().allow('') : Joi.string());
		case 'policy-object':
			return Joi.object().unknown();
		default:
			return buildStringBase(field);
	}
}

/** Applies nullability and requiredness uniformly, so every field type honors the same metadata contract. */
function buildFieldSchema(field: ConfigFieldDescriptor): Joi.Schema {
	let schema = buildBase(field);
	if (field.nullable) schema = schema.allow(null);
	if (field.required) schema = schema.required();
	return schema;
}

function fieldEntries(fields: ConfigFieldDescriptor[]): Record<string, Joi.Schema> {
	return Object.fromEntries(fields.map((field) => [field.name, buildFieldSchema(field)]));
}

export type DocumentSchemaSpec = {
	layout: { documentShape: ConfigDocumentShape };
	documentIdentityFields: ConfigFieldDescriptor[];
	recordFields: ConfigFieldDescriptor[];
};

export function buildDocumentSchema(spec: DocumentSchemaSpec): Joi.ObjectSchema {
	const identity = fieldEntries(spec.documentIdentityFields);
	const shape = spec.layout.documentShape;

	if (shape === 'flat') {
		return Joi.object({ ...identity, ...fieldEntries(spec.recordFields) });
	}

	const recordSchema = Joi.object(fieldEntries(spec.recordFields));
	return Joi.object({ ...identity, [shape.recordsField]: Joi.array().items(recordSchema).required() });
}
