import { normalizeConfigKey } from '@cairncms/utils';
import Joi from 'joi';
import type { ConfigDocumentShape, ConfigFieldDescriptor } from './descriptor.js';

const CONFIG_KEY_GRAMMAR_MESSAGE =
	'{{#label}} must be lowercase alphanumeric with underscores, and cannot start with a digit or underscore.';

const CONFIG_KEY_RESERVED_MESSAGE = '{{#label}} is reserved for public permissions and cannot name a role.';

function buildConfigKeyBase(field: ConfigFieldDescriptor): Joi.Schema {
	let schema = Joi.string();
	if (field.minLength !== undefined) schema = schema.min(field.minLength);
	if (field.maxLength !== undefined) schema = schema.max(field.maxLength);

	schema = schema
		.custom((value, helpers) => (normalizeConfigKey(value) === value ? value : helpers.error('configKey.grammar')))
		.messages({ 'configKey.grammar': CONFIG_KEY_GRAMMAR_MESSAGE });

	if (field.reserved && field.reserved.length > 0) {
		schema = schema.invalid(...field.reserved).messages({ 'any.invalid': CONFIG_KEY_RESERVED_MESSAGE });
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
	if (field.grammar === 'config-key') return buildConfigKeyBase(field);

	switch (field.type) {
		case 'boolean':
			return Joi.boolean();
		case 'string-list':
			return Joi.array().items(field.allowEmptyElements ? Joi.string().allow('') : Joi.string());
		case 'policy-object':
			return Joi.object().unknown();

		case 'number': {
			let schema = Joi.number().integer();
			if (field.min !== undefined) schema = schema.min(field.min);
			if (field.max !== undefined) schema = schema.max(field.max);
			return schema;
		}

		case 'json-array':
			return field.arrayItems === 'record' ? Joi.array().items(Joi.object().unknown()) : Joi.array();
		default:
			return buildStringBase(field);
	}
}

/**
 * A generated snapshot must carry every managed, snapshot-safe field explicitly, so its records reconstruct on a
 * fresh target without silently taking create defaults. An authored declaration may omit optional fields to preserve
 * live values, so authored validation keeps the descriptor's own requiredness.
 */
export type SchemaMode = 'authored' | 'snapshot';

/** Applies nullability and requiredness uniformly, so every field type honors the same metadata contract. */
function buildFieldSchema(field: ConfigFieldDescriptor, mode: SchemaMode): Joi.Schema {
	let schema = buildBase(field);
	if (field.nullable) schema = schema.allow(null);
	if (field.required || (mode === 'snapshot' && field.snapshotSafe)) schema = schema.required();
	return schema;
}

function fieldEntries(fields: ConfigFieldDescriptor[], mode: SchemaMode): Record<string, Joi.Schema> {
	return Object.fromEntries(fields.map((field) => [field.name, buildFieldSchema(field, mode)]));
}

export type DocumentSchemaSpec = {
	layout: { documentShape: ConfigDocumentShape };
	documentIdentityFields: ConfigFieldDescriptor[];
	recordFields: ConfigFieldDescriptor[];
};

export function buildDocumentSchema(spec: DocumentSchemaSpec, mode: SchemaMode = 'authored'): Joi.ObjectSchema {
	const identity = fieldEntries(spec.documentIdentityFields, mode);
	const shape = spec.layout.documentShape;

	if (shape === 'flat' || 'singleton' in shape) {
		return Joi.object({ ...identity, ...fieldEntries(spec.recordFields, mode) });
	}

	const recordSchema = Joi.object(fieldEntries(spec.recordFields, mode));
	return Joi.object({ ...identity, [shape.recordsField]: Joi.array().items(recordSchema).required() });
}
