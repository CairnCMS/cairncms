import { TYPES } from '@cairncms/constants';
import Joi from 'joi';
import { ALIAS_TYPES } from '../constants.js';

export const collectionEntitySchema = Joi.object({
	collection: Joi.string(),
	meta: Joi.any(),
	schema: Joi.object({
		name: Joi.string(),
	}),
});

export const fieldEntitySchema = Joi.object({
	collection: Joi.string(),
	field: Joi.string(),
	meta: Joi.any(),
	schema: Joi.object({
		default_value: Joi.any(),
		max_length: [Joi.number(), Joi.string(), Joi.valid(null)],
		is_nullable: Joi.bool(),
	})
		.unknown()
		.allow(null),
	type: Joi.string()
		.valid(...TYPES, ...ALIAS_TYPES)
		.allow(null),
});

export const relationEntitySchema = Joi.object({
	collection: Joi.string(),
	field: Joi.string(),
	meta: Joi.any(),
	related_collection: Joi.any(),
	schema: Joi.any(),
});
