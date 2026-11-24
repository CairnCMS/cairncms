import type { FieldFilter } from '@cairncms/types';
import type {
	AnySchema,
	StringSchema as BaseStringSchema,
	DateSchema,
	ExtensionRule,
	NumberSchema,
	SchemaInternals,
} from 'joi';
import BaseJoi from 'joi';
import { escapeRegExp, merge } from 'lodash-es';

export interface StringSchema extends BaseStringSchema {
	contains(substring: string): this;
	ncontains(substring: string): this;
	icontains(substring: string): this;
	endsWith(suffix: string): this;
	nendsWith(suffix: string): this;
	istartsWith(prefix: string): this;
	nistartsWith(prefix: string): this;
	iendsWith(suffix: string): this;
	niendsWith(suffix: string): this;
}

function textRule(
	name: string,
	matches: (value: string, text: string) => boolean
): ExtensionRule & ThisType<SchemaInternals> {
	return {
		args: [
			{
				name: 'text',
				ref: true,
				assert: (val) => typeof val === 'string',
				message: 'must be a string',
			},
		],
		method(text) {
			return this.$_addRule({ name, args: { text } });
		},
		validate(value, helpers, { text }) {
			// The rule text can contain private permission data.
			return matches(value, text) ? value : helpers.error(`string.${name}`);
		},
	};
}

export const Joi: typeof BaseJoi = BaseJoi.extend({
	type: 'string',
	base: BaseJoi.string(),
	messages: {
		'string.contains': '{{#label}} must contain [{{#substring}}]',
		'string.ncontains': "{{#label}} can't contain [{{#substring}}]",
		'string.icontains': '{{#label}} must contain the required text',
		'string.endsWith': '{{#label}} must end with the required text',
		'string.nendsWith': "{{#label}} can't end with the excluded text",
		'string.istartsWith': '{{#label}} must start with the required text',
		'string.nistartsWith': "{{#label}} can't start with the excluded text",
		'string.iendsWith': '{{#label}} must end with the required text',
		'string.niendsWith': "{{#label}} can't end with the excluded text",
	},
	rules: {
		contains: {
			args: [
				{
					name: 'substring',
					ref: true,
					assert: (val) => typeof val === 'string',
					message: 'must be a string',
				},
			],
			method(substring) {
				return this.$_addRule({ name: 'contains', args: { substring } });
			},
			validate(value, helpers, { substring }) {
				if (value.includes(substring) === false) {
					return helpers.error('string.contains', { substring });
				}

				return value;
			},
		},
		ncontains: {
			args: [
				{
					name: 'substring',
					ref: true,
					assert: (val) => typeof val === 'string',
					message: 'must be a string',
				},
			],
			method(substring) {
				return this.$_addRule({ name: 'ncontains', args: { substring } });
			},
			validate(value, helpers, { substring }) {
				if (value.includes(substring) === true) {
					return helpers.error('string.ncontains', { substring });
				}

				return value;
			},
		},
		icontains: textRule('icontains', (value, text) => value.toLowerCase().includes(text.toLowerCase())),
		endsWith: textRule('endsWith', (value, text) => value.endsWith(text)),
		nendsWith: textRule('nendsWith', (value, text) => !value.endsWith(text)),
		istartsWith: textRule('istartsWith', (value, text) => value.toLowerCase().startsWith(text.toLowerCase())),
		nistartsWith: textRule('nistartsWith', (value, text) => !value.toLowerCase().startsWith(text.toLowerCase())),
		iendsWith: textRule('iendsWith', (value, text) => value.toLowerCase().endsWith(text.toLowerCase())),
		niendsWith: textRule('niendsWith', (value, text) => !value.toLowerCase().endsWith(text.toLowerCase())),
	},
});

export type JoiOptions = {
	requireAll?: boolean;
};

const defaults: JoiOptions = {
	requireAll: false,
};

const NO_MATCH_SENTINEL = Symbol('cairncms-no-match');

const TAGGED_OPERATORS: readonly string[] = [
	'_eq',
	'_neq',
	'_in',
	'_nin',
	'_null',
	'_nnull',
	'_empty',
	'_nempty',
	'_contains',
	'_icontains',
	'_ncontains',
	'_starts_with',
	'_nstarts_with',
	'_istarts_with',
	'_nistarts_with',
	'_ends_with',
	'_nends_with',
	'_iends_with',
	'_niends_with',
	'_regex',
	'_gt',
	'_gte',
	'_lt',
	'_lte',
	'_between',
	'_nbetween',
];

function withValidationOperator(schema: AnySchema, operator: string): AnySchema {
	return schema.error((errors) => {
		for (const error of errors) error.local.validationOperator = operator;
		return errors;
	});
}

/** Callers handle _and and _or groups and pass one field rule at a time. */
export function generateJoi(filter: FieldFilter | null, options?: JoiOptions): AnySchema {
	filter = filter || {};

	options = merge({}, defaults, options);

	const schema: Record<string, AnySchema> = {};

	const key = Object.keys(filter)[0];

	if (!key) {
		throw new Error(`[generateJoi] Filter doesn't contain field key. Passed filter: ${JSON.stringify(filter)}`);
	}

	const value = Object.values(filter)[0];

	if (!value) {
		throw new Error(`[generateJoi] Filter doesn't contain filter rule. Passed filter: ${JSON.stringify(filter)}`);
	}

	if (Object.keys(value)[0]?.startsWith('_') === false) {
		schema[key] = generateJoi(value as FieldFilter, options);
	} else {
		const operator = Object.keys(value)[0];
		const compareValue = Object.values(value)[0];

		const getAnySchema = () => schema[key] ?? Joi.any();
		const getStringSchema = () => (schema[key] ?? Joi.string()) as StringSchema;
		const getNumberSchema = () => (schema[key] ?? Joi.number()) as NumberSchema;
		const getDateSchema = () => (schema[key] ?? Joi.date()) as DateSchema;

		if (operator === '_eq') {
			const numericValue =
				compareValue === null || compareValue === '' || compareValue === true || compareValue === false
					? NaN
					: Number(compareValue);

			if (isNaN(numericValue)) {
				schema[key] = getAnySchema().equal(compareValue);
			} else {
				schema[key] = getAnySchema().equal(compareValue, numericValue);
			}
		}

		if (operator === '_neq') {
			const numericValue =
				compareValue === null || compareValue === '' || compareValue === true || compareValue === false
					? NaN
					: Number(compareValue);

			if (isNaN(numericValue)) {
				schema[key] = getAnySchema().not(compareValue);
			} else {
				schema[key] = getAnySchema().not(compareValue, numericValue);
			}
		}

		if (operator === '_contains') {
			if (compareValue === null || compareValue === undefined || typeof compareValue !== 'string') {
				schema[key] = Joi.any().equal(true);
			} else {
				schema[key] = getStringSchema().contains(compareValue);
			}
		}

		if (operator === '_icontains') {
			if (typeof compareValue !== 'string') {
				schema[key] = Joi.any().valid(NO_MATCH_SENTINEL);
			} else {
				schema[key] = getStringSchema().icontains(compareValue);
			}
		}

		if (operator === '_ncontains') {
			if (compareValue === null || compareValue === undefined || typeof compareValue !== 'string') {
				schema[key] = Joi.any().equal(true);
			} else {
				schema[key] = getStringSchema().ncontains(compareValue);
			}
		}

		if (operator === '_starts_with') {
			if (compareValue === null || compareValue === undefined || typeof compareValue !== 'string') {
				schema[key] = Joi.any().equal(true);
			} else {
				schema[key] = getStringSchema().pattern(new RegExp(`^${escapeRegExp(compareValue)}.*`), {
					name: 'starts_with',
				});
			}
		}

		if (operator === '_nstarts_with') {
			if (compareValue === null || compareValue === undefined || typeof compareValue !== 'string') {
				schema[key] = Joi.any().equal(true);
			} else {
				schema[key] = getStringSchema().pattern(new RegExp(`^${escapeRegExp(compareValue)}.*`), {
					name: 'nstarts_with',
					invert: true,
				});
			}
		}

		if (operator === '_istarts_with') {
			if (typeof compareValue !== 'string') {
				schema[key] = Joi.any().valid(NO_MATCH_SENTINEL);
			} else {
				schema[key] = getStringSchema().istartsWith(compareValue);
			}
		}

		if (operator === '_nistarts_with') {
			if (typeof compareValue !== 'string') {
				schema[key] = Joi.any().valid(NO_MATCH_SENTINEL);
			} else {
				schema[key] = getStringSchema().nistartsWith(compareValue);
			}
		}

		if (operator === '_ends_with') {
			if (compareValue === null || compareValue === undefined || typeof compareValue !== 'string') {
				schema[key] = Joi.any().equal(true);
			} else {
				schema[key] = getStringSchema().endsWith(compareValue);
			}
		}

		if (operator === '_nends_with') {
			if (compareValue === null || compareValue === undefined || typeof compareValue !== 'string') {
				schema[key] = Joi.any().equal(true);
			} else {
				schema[key] = getStringSchema().nendsWith(compareValue);
			}
		}

		if (operator === '_iends_with') {
			if (typeof compareValue !== 'string') {
				schema[key] = Joi.any().valid(NO_MATCH_SENTINEL);
			} else {
				schema[key] = getStringSchema().iendsWith(compareValue);
			}
		}

		if (operator === '_niends_with') {
			if (typeof compareValue !== 'string') {
				schema[key] = Joi.any().valid(NO_MATCH_SENTINEL);
			} else {
				schema[key] = getStringSchema().niendsWith(compareValue);
			}
		}

		if (operator === '_in') {
			if (Array.isArray(compareValue) && compareValue.length === 0) {
				schema[key] = Joi.any().valid(NO_MATCH_SENTINEL);
			} else {
				schema[key] = getAnySchema().equal(...(compareValue as (string | number)[]));
			}
		}

		if (operator === '_nin') {
			if (Array.isArray(compareValue) && compareValue.length === 0) {
				schema[key] = Joi.any();
			} else {
				schema[key] = getAnySchema().not(...(compareValue as (string | number)[]));
			}
		}

		if (operator === '_gt') {
			const isDate = compareValue instanceof Date || Number.isNaN(Number(compareValue));

			schema[key] = isDate
				? getDateSchema().greater(compareValue as string | Date)
				: getNumberSchema().greater(Number(compareValue));
		}

		if (operator === '_gte') {
			const isDate = compareValue instanceof Date || Number.isNaN(Number(compareValue));

			schema[key] = isDate
				? getDateSchema().min(compareValue as string | Date)
				: getNumberSchema().min(Number(compareValue));
		}

		if (operator === '_lt') {
			const isDate = compareValue instanceof Date || Number.isNaN(Number(compareValue));

			schema[key] = isDate
				? getDateSchema().less(compareValue as string | Date)
				: getNumberSchema().less(Number(compareValue));
		}

		if (operator === '_lte') {
			const isDate = compareValue instanceof Date || Number.isNaN(Number(compareValue));

			schema[key] = isDate
				? getDateSchema().max(compareValue as string | Date)
				: getNumberSchema().max(Number(compareValue));
		}

		if (operator === '_null') {
			schema[key] = getAnySchema().valid(null);
		}

		if (operator === '_nnull') {
			schema[key] = getAnySchema().invalid(null);
		}

		if (operator === '_empty') {
			schema[key] = getAnySchema().valid('');
		}

		if (operator === '_nempty') {
			schema[key] = getAnySchema().invalid('');
		}

		if (operator === '_between') {
			if (
				(compareValue as any).every((value: any) => {
					const val = Number(value instanceof Date ? NaN : value);
					return !Number.isNaN(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER;
				})
			) {
				const values = compareValue as [number, number];
				schema[key] = getNumberSchema().min(Number(values[0])).max(Number(values[1]));
			} else {
				const values = compareValue as [string, string];
				schema[key] = getDateSchema().min(values[0]).max(values[1]);
			}
		}

		if (operator === '_nbetween') {
			if (
				(compareValue as any).every((value: any) => {
					const val = Number(value instanceof Date ? NaN : value);
					return !Number.isNaN(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER;
				})
			) {
				const values = compareValue as [number, number];
				schema[key] = getNumberSchema().less(Number(values[0])).greater(Number(values[1]));
			} else {
				const values = compareValue as [string, string];
				schema[key] = getDateSchema().less(values[0]).greater(values[1]);
			}
		}

		if (operator === '_submitted') {
			schema[key] = getAnySchema().required();
		}

		if (operator === '_regex') {
			if (compareValue === null || compareValue === undefined) {
				schema[key] = Joi.any().equal(true);
			} else {
				const wrapped =
					typeof compareValue === 'string' ? compareValue.startsWith('/') && compareValue.endsWith('/') : false;

				schema[key] = getStringSchema().regex(new RegExp(wrapped ? (compareValue as any).slice(1, -1) : compareValue));
			}
		}

		const operatorSchema = schema[key];

		if (operator !== undefined && operatorSchema && TAGGED_OPERATORS.includes(operator)) {
			schema[key] = withValidationOperator(operatorSchema, operator);
		}
	}

	schema[key] = schema[key] ?? Joi.any();

	if (options.requireAll) {
		schema[key] = schema[key]!.required();
	}

	return Joi.object(schema).unknown();
}
