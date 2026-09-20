import { ExtensionSettingKeySchema } from '@cairncms/constants';
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

/**
 * Portable structure only; declaration-specific checks happen on the target.
 * unsafe() admits the finite numbers accepted by the settings API beyond Joi's safe-number range.
 */
export const EXTENSION_SETTING_LEAF_SCHEMA = Joi.alternatives(
	Joi.string().allow(''),
	Joi.number().unsafe(),
	Joi.boolean(),
	Joi.object({ $secret: Joi.valid('preserve').required() }).strict()
);

const EXTENSION_SETTING_KEY_SCHEMA = Joi.string().custom((value, helpers) =>
	ExtensionSettingKeySchema.safeParse(value).success ? value : helpers.error('any.invalid')
);

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
 * Snapshots require all snapshot-safe fields to avoid adopting target defaults.
 * Authored documents use each field's declared requiredness.
 */
export type SchemaMode = 'authored' | 'snapshot';

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

	if ('nestedMap' in shape) {
		const valueMap = Joi.object().pattern(EXTENSION_SETTING_KEY_SCHEMA, EXTENSION_SETTING_LEAF_SCHEMA);
		const collectionsMap = Joi.object().pattern(Joi.string(), valueMap);
		const globalSchema = mode === 'snapshot' ? valueMap.required() : valueMap;
		const collectionsSchema = mode === 'snapshot' ? collectionsMap.required() : collectionsMap;
		return Joi.object({
			...identity,
			[shape.nestedMap.globalField]: globalSchema,
			[shape.nestedMap.collectionsField]: collectionsSchema,
		});
	}

	if ('keyedMap' in shape) {
		const valueMap = Joi.object().pattern(Joi.string().allow(''), Joi.string().allow(''));
		const fieldSchema = mode === 'snapshot' ? valueMap.required() : valueMap;
		return Joi.object({ ...identity, [shape.keyedMap.field]: fieldSchema });
	}

	const recordSchema = Joi.object(fieldEntries(spec.recordFields, mode));
	return Joi.object({ ...identity, [shape.recordsField]: Joi.array().items(recordSchema).required() });
}
