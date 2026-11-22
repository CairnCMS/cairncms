import type { FieldFilter } from '@cairncms/types';
import type { AnySchema, Description } from 'joi';
import { escapeRegExp, omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import type { JoiOptions, StringSchema } from './generate-joi.js';
import { Joi, generateJoi } from './generate-joi.js';

/** Describes a schema without the error callbacks that record a rule's operator. */
function describeRules(schema: AnySchema): Description {
	const strip = (description: Description) => {
		const flags = description['flags'] as Record<string, unknown> | undefined;

		if (flags && typeof flags['error'] === 'function') {
			delete flags['error'];
			if (Object.keys(flags).length === 0) delete description['flags'];
		}

		for (const child of Object.values((description['keys'] ?? {}) as Record<string, Description>)) strip(child);
	};

	const description = schema.describe();
	strip(description);
	return description;
}

function outcome(schema: AnySchema, payload: Record<string, unknown>) {
	const { value, error } = schema.validate(payload, { abortEarly: false });

	return {
		value,
		details: error?.details.map((detail) => ({ ...detail, context: omit(detail.context, 'validationOperator') })),
	};
}

describe(`generateJoi`, () => {
	const date = new Date(1632431505992);
	const compareDate = new Date(1632431605992);

	it(`returns an error when no key is passed`, () => {
		const mockFieldFilter = {} as FieldFilter;
		const mockError = `[generateJoi] Filter doesn't contain field key. Passed filter: {}`;

		expect(() => {
			generateJoi(mockFieldFilter);
		}).toThrowError(mockError);
	});

	it(`returns an error when no filter rule is passed`, () => {
		const mockFieldFilter = { field: { eq: undefined } } as unknown as FieldFilter;
		const mockError = `[generateJoi] Filter doesn't contain filter rule. Passed filter: {}`;

		expect(() => {
			generateJoi(mockFieldFilter);
		}).toThrowError(mockError);
	});

	it(`returns an recursively goes through nested filters`, () => {
		const mockFieldFilter = { field: { eq: { _eq: 'field' } } } as unknown as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.object({ eq: Joi.any().equal('field') }).unknown(),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema with an option of "requireAll" true`, () => {
		const mockFieldFilter = { field: { _eq: 'field' } } as FieldFilter;
		const mockOptions = { requireAll: true } as JoiOptions;

		const mockSchema = Joi.object({
			field: Joi.any().equal('field').required(),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter, mockOptions))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _eq match`, () => {
		const mockFieldFilter = { field: { _eq: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal('field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a _neq match`, () => {
		const mockFieldFilter = { field: { _neq: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not('field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an integer _eq match`, () => {
		const mockFieldFilter = { field: { _eq: '123' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal('123', 123),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an integer _neq match`, () => {
		const mockFieldFilter = { field: { _neq: '123' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not('123', 123),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a float _eq match`, () => {
		const mockFieldFilter = { field: { _eq: '123.456' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal('123.456', 123.456),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a float _neq match`, () => {
		const mockFieldFilter = { field: { _neq: '123.456' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not('123.456', 123.456),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a null _eq match`, () => {
		const mockFieldFilter = { field: { _eq: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(null),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a null _neq match`, () => {
		const mockFieldFilter = { field: { _neq: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(null),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an empty string _eq match`, () => {
		const mockFieldFilter = { field: { _eq: '' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(''),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an empty string _neq match`, () => {
		const mockFieldFilter = { field: { _neq: '' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(''),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a true _eq match`, () => {
		const mockFieldFilter = { field: { _eq: true } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a true _neq match`, () => {
		const mockFieldFilter = { field: { _neq: true } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a false _eq match`, () => {
		const mockFieldFilter = { field: { _eq: false } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(false),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a false _neq match`, () => {
		const mockFieldFilter = { field: { _neq: false } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(false),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _ncontains contain match`, () => {
		const mockFieldFilter = { field: { _ncontains: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: (Joi.string() as StringSchema).ncontains('field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _ncontains with null value`, () => {
		const mockFieldFilter = { field: { _ncontains: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _contains contain match`, () => {
		const mockFieldFilter = { field: { _contains: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: (Joi.string() as StringSchema).contains('field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _contains with null value`, () => {
		const mockFieldFilter = { field: { _contains: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _icontains contain match`, () => {
		const mockFieldFilter = { field: { _icontains: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: (Joi.string() as StringSchema).contains('field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _icontains with null value`, () => {
		const mockFieldFilter = { field: { _icontains: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns a value if the substring is included in the value`, () => {
		expect(() => {
			Joi.assert('testfield', (Joi.string() as StringSchema).contains('field'));
		}).toEqual(expect.any(Function));
	});

	it(`returns a value if the substring is not contained in the value`, () => {
		expect(() => {
			Joi.assert('testfield', (Joi.string() as StringSchema).contains('field'));
		}).toEqual(expect.any(Function));
	});

	it(`returns an error if the substring is included in the value`, () => {
		expect(() => {
			Joi.assert('field', (Joi.string() as StringSchema).ncontains('field'));
			// eslint-disable-next-line no-useless-escape
		}).toThrowError(`\"value\" can't contain [field]`);
	});

	it(`returns an error if the substring is not contained in the value`, () => {
		expect(() => {
			Joi.assert('test', (Joi.string() as StringSchema).contains('field'));
			// eslint-disable-next-line no-useless-escape
		}).toThrowError(`\"value\" must contain [field`);
	});

	it(`returns the correct schema for a _starts_with match`, () => {
		const mockFieldFilter = { field: { _starts_with: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.string().pattern(new RegExp(`^${escapeRegExp('field')}.*`), {
				name: 'starts_with',
			}),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a _starts_with with null value`, () => {
		const mockFieldFilter = { field: { _starts_with: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a _nstarts_with with match`, () => {
		const mockFieldFilter = { field: { _nstarts_with: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.string().pattern(new RegExp(`^${escapeRegExp('field')}.*`), {
				name: 'nstarts_with',
				invert: true,
			}),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a _nstarts_with with null value`, () => {
		const mockFieldFilter = { field: { _nstarts_with: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an ends_with match`, () => {
		const mockFieldFilter = { field: { _ends_with: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.string().pattern(new RegExp(`.*field$`), {
				name: 'ends_with',
			}),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an ends_with with null value`, () => {
		const mockFieldFilter = { field: { _ends_with: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a doesnt _nends_with match`, () => {
		const mockFieldFilter = { field: { _nends_with: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.string().pattern(new RegExp(`.*field$`), {
				name: 'nends_with',
				invert: true,
			}),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a doesnt _nends_with with null value`, () => {
		const mockFieldFilter = { field: { _nends_with: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it.each([
		['_istarts_with', 'istartsWith'],
		['_nistarts_with', 'nistartsWith'],
		['_iends_with', 'iendsWith'],
		['_niends_with', 'niendsWith'],
	] as const)(`returns the correct schema for a %s match`, (operator, rule) => {
		const mockFieldFilter = { field: { [operator]: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: (Joi.string() as StringSchema)[rule]('field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _in match`, () => {
		const mockFieldFilter = { field: { _in: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(...'field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _in number array match`, () => {
		const mockFieldFilter = { field: { _in: [1] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(...[1]),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _in a string array match`, () => {
		const mockFieldFilter = { field: { _in: ['field', 'secondField'] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(...['field', 'secondField']),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for a _nin match`, () => {
		const mockFieldFilter = { field: { _nin: 'field' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(...'field'),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nin number array match`, () => {
		const mockFieldFilter = { field: { _nin: [1] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(...[1]),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nin a string array match`, () => {
		const mockFieldFilter = { field: { _nin: ['field', 'secondField'] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().not(...['field', 'secondField']),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _gt number match`, () => {
		const mockFieldFilter = { field: { _gt: 1 } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().greater(1),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _gt date match`, () => {
		const mockFieldFilter = { field: { _gt: date } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().greater(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _gt string match`, () => {
		const mockFieldFilter = { field: { _gt: date.toISOString() } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().greater(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _gte number match`, () => {
		const mockFieldFilter = { field: { _gte: 1 } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().min(1),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _gte date match`, () => {
		const mockFieldFilter = { field: { _gte: date } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().min(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _gte string match`, () => {
		const mockFieldFilter = { field: { _gte: date.toISOString() } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().min(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _lt number match`, () => {
		const mockFieldFilter = { field: { _lt: 1 } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().less(1),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _lt date match`, () => {
		const mockFieldFilter = { field: { _lt: date } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().less(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _lt string match`, () => {
		const mockFieldFilter = { field: { _lt: date.toISOString() } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().less(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _lte number match`, () => {
		const mockFieldFilter = { field: { _lte: 1 } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().max(1),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _lte date match`, () => {
		const mockFieldFilter = { field: { _lte: date } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().max(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _lte string match`, () => {
		const mockFieldFilter = { field: { _lte: date.toISOString() } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().max(date),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _null match`, () => {
		const mockFieldFilter = { field: { _null: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().valid(null),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nnull match`, () => {
		const mockFieldFilter = { field: { _nnull: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().invalid(null),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _empty match`, () => {
		const mockFieldFilter = { field: { _empty: '' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().valid(''),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nempty match`, () => {
		const mockFieldFilter = { field: { _nempty: '' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().invalid(''),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _between number match`, () => {
		const mockFieldFilter = { field: { _between: [1, 3] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().min(1).max(3),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _between float match`, () => {
		const mockFieldFilter = { field: { _between: [1.111, 3.333] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().min(1.111).max(3.333),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _between date match`, () => {
		const mockFieldFilter = { field: { _between: [date, compareDate] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().min(date).max(compareDate),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nbetween number match`, () => {
		const mockFieldFilter = { field: { _nbetween: [1, 3] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().less(1).greater(3),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nbetween float match`, () => {
		const mockFieldFilter = { field: { _nbetween: [1.111, 3.333] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.number().less(1.111).greater(3.333),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _nbetween date match`, () => {
		const mockFieldFilter = { field: { _nbetween: [date, compareDate] } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.date().less(date).greater(compareDate),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _submitted match`, () => {
		const mockFieldFilter = { field: { _submitted: '' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().required(),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _regex match when wrapped`, () => {
		const mockFieldFilter = { field: { _regex: '/.*field$/' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.string().regex(new RegExp(`.*field$`)),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _regex match when unwrapped`, () => {
		const mockFieldFilter = { field: { _regex: '.*field$' } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.string().regex(new RegExp(`.*field$`)),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	it(`returns the correct schema for an _regex match with null value`, () => {
		const mockFieldFilter = { field: { _regex: null } } as FieldFilter;

		const mockSchema = Joi.object({
			field: Joi.any().equal(true),
		})
			.unknown()
			.describe();

		expect(describeRules(generateJoi(mockFieldFilter))).toStrictEqual(mockSchema);
	});

	describe(`_in / _nin with empty arrays (GHSA-hxgm-ghmv-xjjm)`, () => {
		it(`_in [] rejects a string payload value`, () => {
			const schema = generateJoi({ field: { _in: [] } } as unknown as FieldFilter);
			expect(schema.validate({ field: 'anything' }).error).toBeDefined();
		});

		it(`_in [] rejects a numeric payload value`, () => {
			const schema = generateJoi({ field: { _in: [] } } as unknown as FieldFilter);
			expect(schema.validate({ field: 42 }).error).toBeDefined();
		});

		it(`_in [] rejects a null payload value`, () => {
			const schema = generateJoi({ field: { _in: [] } } as unknown as FieldFilter);
			expect(schema.validate({ field: null }).error).toBeDefined();
		});

		it(`_in [] is vacuously satisfied when the keyed field is absent from the payload`, () => {
			const schema = generateJoi({ field: { _in: [] } } as unknown as FieldFilter);
			expect(schema.validate({}).error).toBeUndefined();
		});

		it(`_nin [] accepts a string payload value`, () => {
			const schema = generateJoi({ field: { _nin: [] } } as unknown as FieldFilter);
			expect(schema.validate({ field: 'anything' }).error).toBeUndefined();
		});

		it(`_nin [] accepts a null payload value`, () => {
			const schema = generateJoi({ field: { _nin: [] } } as unknown as FieldFilter);
			expect(schema.validate({ field: null }).error).toBeUndefined();
		});

		it(`_in ['allowed'] accepts 'allowed' and rejects 'other'`, () => {
			const schema = generateJoi({ field: { _in: ['allowed'] } } as unknown as FieldFilter);
			expect(schema.validate({ field: 'allowed' }).error).toBeUndefined();
			expect(schema.validate({ field: 'other' }).error).toBeDefined();
		});

		it(`_nin ['blocked'] accepts 'allowed' and rejects 'blocked'`, () => {
			const schema = generateJoi({ field: { _nin: ['blocked'] } } as unknown as FieldFilter);
			expect(schema.validate({ field: 'allowed' }).error).toBeUndefined();
			expect(schema.validate({ field: 'blocked' }).error).toBeDefined();
		});
	});

	describe(`case-insensitive starts and ends rules`, () => {
		const OPERATORS = ['_istarts_with', '_nistarts_with', '_iends_with', '_niends_with'];

		const passes = (rule: Record<string, unknown>, field: unknown) =>
			generateJoi({ field: rule } as unknown as FieldFilter).validate({ field }).error === undefined;

		it.each([
			['_istarts_with', 'abc', 'abcdef', true],
			['_istarts_with', 'abc', 'ABCdef', true],
			['_istarts_with', 'AbC', 'aBcdef', true],
			['_istarts_with', 'abc', 'xabc', false],
			['_nistarts_with', 'abc', 'ABCdef', false],
			['_nistarts_with', 'abc', 'xabc', true],
			['_iends_with', 'abc', 'xyzabc', true],
			['_iends_with', 'abc', 'xyzABC', true],
			['_iends_with', 'aBc', 'xyzAbC', true],
			['_iends_with', 'abc', 'abcx', false],
			['_niends_with', 'abc', 'xyzAbC', false],
			['_niends_with', 'abc', 'abcx', true],
		])(`%s %j against %j passes: %s`, (operator, operand, field, expected) => {
			expect(passes({ [operator]: operand }, field)).toBe(expected);
		});

		it.each([
			['_istarts_with', '_nistarts_with', 'a.c', 'A.Cd', 'abcd'],
			['_istarts_with', '_nistarts_with', '(a', '(Abc', 'abc'],
			['_istarts_with', '_nistarts_with', '50%', '50%off', '500off'],
			['_istarts_with', '_nistarts_with', 'team_a', 'TEAM_A1', 'teamXa1'],
			['_iends_with', '_niends_with', 'x*', 'zzX*', 'zzz'],
			['_iends_with', '_niends_with', 'team_a', '1TEAM_A', '1teamXa'],
		])(`%s and %s match %j literally`, (operator, negation, operand, literal, other) => {
			expect(passes({ [operator]: operand }, literal)).toBe(true);
			expect(passes({ [operator]: operand }, other)).toBe(false);
			expect(passes({ [negation]: operand }, literal)).toBe(false);
			expect(passes({ [negation]: operand }, other)).toBe(true);
		});

		it.each([
			['_istarts_with', 'i', `${String.fromCodePoint(0x130)}stanbul`, true],
			['_istarts_with', String.fromCodePoint(0xdf), String.fromCodePoint(0x1e9e), true],
			['_istarts_with', 'ss', String.fromCodePoint(0xdf), false],
			['_iends_with', 'k', `MAR${String.fromCodePoint(0x212a)}`, true],
		])(`%s %j against %j compares lowercased text, passes: %s`, (operator, operand, field, expected) => {
			expect(passes({ [operator]: operand }, field)).toBe(expected);
		});

		it(`treats an empty operand as a prefix and suffix of every text`, () => {
			expect(passes({ _istarts_with: '' }, 'abc')).toBe(true);
			expect(passes({ _iends_with: '' }, 'abc')).toBe(true);
			expect(passes({ _nistarts_with: '' }, 'abc')).toBe(false);
			expect(passes({ _niends_with: '' }, 'abc')).toBe(false);
		});

		it.each(OPERATORS)(
			`%s rejects an empty submitted value before comparing, as the case-sensitive rules do`,
			(operator) => {
				expect(passes({ [operator]: 'abc' }, '')).toBe(false);
			}
		);

		it.each(OPERATORS)(`%s rejects every provided value when its operand isn't text`, (operator) => {
			for (const operand of [null, undefined, 42, true, new Date(0)]) {
				const filter = { field: { [operator]: operand } } as unknown as FieldFilter;

				for (const field of ['abc', '', 42, true, null, String(operand)]) {
					const { error } = generateJoi(filter).validate({ field });

					expect(error?.details[0]?.context?.['validationOperator'], JSON.stringify({ operand, field })).toBe(operator);
				}

				expect(generateJoi(filter).validate({}).error).toBeUndefined();
				expect(generateJoi(filter, { requireAll: true }).validate({}).error?.details[0]?.type).toBe('any.required');
			}
		});

		it.each([
			['_istarts_with', 'zzz'],
			['_nistarts_with', 'operand_markerzzz'],
			['_iends_with', 'zzz'],
			['_niends_with', 'zzzoperand_marker'],
		])(`%s reports a failure without the rule's text`, (operator, field) => {
			const filter = { field: { [operator]: 'OPERAND_MARKER' } } as unknown as FieldFilter;
			const detail = generateJoi(filter).validate({ field }).error?.details[0];
			const contextKeys = Object.keys(detail?.context ?? {}).sort();

			expect(detail?.message).not.toContain('OPERAND_MARKER');
			expect(contextKeys).toEqual(['key', 'label', 'validationOperator', 'value']);
		});
	});

	describe(`validation operator tags`, () => {
		it.each([
			['_eq', { _eq: 'word' }, 'other', 'any.only'],
			['_neq', { _neq: 'word' }, 'word', 'any.invalid'],
			['_in', { _in: ['a'] }, 'other', 'any.only'],
			['_in', { _in: [] }, 'other', 'any.only'],
			['_nin', { _nin: ['a'] }, 'a', 'any.invalid'],
			['_null', { _null: true }, 'x', 'any.only'],
			['_nnull', { _nnull: true }, null, 'any.invalid'],
			['_empty', { _empty: true }, 'x', 'any.only'],
			['_nempty', { _nempty: true }, '', 'any.invalid'],
			['_contains', { _contains: 'a' }, 'b', 'string.contains'],
			['_contains', { _contains: null }, 'b', 'any.only'],
			['_icontains', { _icontains: 'a' }, 42, 'string.base'],
			['_ncontains', { _ncontains: 'a' }, 'a', 'string.ncontains'],
			['_starts_with', { _starts_with: 'a' }, 'b', 'string.pattern.name'],
			['_starts_with', { _starts_with: null }, 'b', 'any.only'],
			['_nstarts_with', { _nstarts_with: 'a' }, 'a', 'string.pattern.invert.name'],
			['_ends_with', { _ends_with: 'a' }, 42, 'string.base'],
			['_nends_with', { _nends_with: 42 }, 'a', 'any.only'],
			['_istarts_with', { _istarts_with: 'a' }, 'b', 'string.istartsWith'],
			['_istarts_with', { _istarts_with: null }, 'b', 'any.only'],
			['_nistarts_with', { _nistarts_with: 'a' }, 'A', 'string.nistartsWith'],
			['_iends_with', { _iends_with: 'a' }, 42, 'string.base'],
			['_iends_with', { _iends_with: 'a' }, 'b', 'string.iendsWith'],
			['_niends_with', { _niends_with: 'a' }, 'bA', 'string.niendsWith'],
			['_niends_with', { _niends_with: 42 }, 'a', 'any.only'],
			['_regex', { _regex: '^a' }, 'b', 'string.pattern.base'],
			['_regex', { _regex: null }, 'b', 'any.only'],
			['_gt', { _gt: 5 }, 1, 'number.greater'],
			['_gt', { _gt: 5 }, 'x', 'number.base'],
			['_gte', { _gte: '2026-01-01' }, '2020-01-01', 'date.min'],
			['_lt', { _lt: '2026-01-01' }, 'x', 'date.base'],
			['_lte', { _lte: 5 }, 7, 'number.max'],
			['_between', { _between: [10, 20] }, 7, 'number.min'],
			['_nbetween', { _nbetween: [10, 20] }, 25, 'number.less'],
		])(`records %s on the errors it reports`, (operator, rule, input, type) => {
			const { error } = generateJoi({ field: rule } as unknown as FieldFilter).validate({ field: input });

			expect(error?.details).toHaveLength(1);
			expect(error?.details[0]?.type).toBe(type);
			expect(error?.details[0]?.context?.['validationOperator']).toBe(operator);
		});

		const references: [string, Record<string, unknown>, AnySchema][] = [
			['_eq a word', { _eq: 'word' }, Joi.any().equal('word')],
			['_eq a numeric string', { _eq: '4821' }, Joi.any().equal('4821', 4821)],
			['_eq null', { _eq: null }, Joi.any().equal(null)],
			['_eq an empty string', { _eq: '' }, Joi.any().equal('')],
			['_neq a word', { _neq: 'word' }, Joi.any().not('word')],
			['_neq a numeric string', { _neq: '4821' }, Joi.any().not('4821', 4821)],
			['_in one value', { _in: ['a'] }, Joi.any().equal('a')],
			['_in two values', { _in: ['a', 'b'] }, Joi.any().equal('a', 'b')],
			['_in null', { _in: [null] }, Joi.any().equal(null)],
			['_nin one value', { _nin: ['a'] }, Joi.any().not('a')],
			['_nin two values', { _nin: ['a', 'b'] }, Joi.any().not('a', 'b')],
			['_nin no values', { _nin: [] }, Joi.any()],
			['_null', { _null: true }, Joi.any().valid(null)],
			['_nnull', { _nnull: true }, Joi.any().invalid(null)],
			['_empty', { _empty: true }, Joi.any().valid('')],
			['_nempty', { _nempty: true }, Joi.any().invalid('')],
			['_contains a word', { _contains: 'a' }, (Joi.string() as StringSchema).contains('a')],
			['_contains null', { _contains: null }, Joi.any().equal(true)],
			['_icontains a word', { _icontains: 'a' }, (Joi.string() as StringSchema).contains('a')],
			['_ncontains a word', { _ncontains: 'a' }, (Joi.string() as StringSchema).ncontains('a')],
			['_ncontains a number', { _ncontains: 42 }, Joi.any().equal(true)],
			['_starts_with a word', { _starts_with: 'a' }, Joi.string().pattern(/^a.*/, { name: 'starts_with' })],
			['_starts_with null', { _starts_with: null }, Joi.any().equal(true)],
			[
				'_nstarts_with a word',
				{ _nstarts_with: 'a' },
				Joi.string().pattern(/^a.*/, { name: 'nstarts_with', invert: true }),
			],
			['_ends_with a word', { _ends_with: 'a' }, Joi.string().pattern(/.*a$/, { name: 'ends_with' })],
			['_nends_with a word', { _nends_with: 'a' }, Joi.string().pattern(/.*a$/, { name: 'nends_with', invert: true })],
			['_regex a pattern', { _regex: '^a' }, Joi.string().regex(/^a/)],
			['_regex a number', { _regex: 42 }, Joi.string().regex(/42/)],
			['_regex null', { _regex: null }, Joi.any().equal(true)],
			['_gt a number', { _gt: 5 }, Joi.number().greater(5)],
			['_gt a date', { _gt: '2026-01-01' }, Joi.date().greater('2026-01-01')],
			['_gt null', { _gt: null }, Joi.number().greater(0)],
			['_gte a number', { _gte: 5 }, Joi.number().min(5)],
			['_lt a date', { _lt: '2026-01-01' }, Joi.date().less('2026-01-01')],
			['_lte a number', { _lte: 5 }, Joi.number().max(5)],
			['_between numbers', { _between: [1, 5] }, Joi.number().min(1).max(5)],
			['_between dates', { _between: ['2026-01-01', '2027-01-01'] }, Joi.date().min('2026-01-01').max('2027-01-01')],
			['_nbetween numbers', { _nbetween: [1, 5] }, Joi.number().less(1).greater(5)],
		];

		const payloads = [
			{},
			...['word', '4821', 4821, null, '', 'a', 'b', true, 3, 42, '42', 'abc', '2026-06-01', 1e300].map((field) => ({
				field,
			})),
		];

		it.each(references)(`keeps the outcome of %s unchanged`, (_label, rule, reference) => {
			const filter = { field: rule } as unknown as FieldFilter;

			for (const payload of payloads) {
				expect(outcome(generateJoi(filter), payload)).toStrictEqual(
					outcome(Joi.object({ field: reference }).unknown(), payload)
				);

				expect(outcome(generateJoi(filter, { requireAll: true }), payload)).toStrictEqual(
					outcome(Joi.object({ field: reference.required() }).unknown(), payload)
				);
			}
		});

		it(`keeps the tag on a nested field`, () => {
			const filter = { field: { nested: { _eq: 'a' } } } as unknown as FieldFilter;
			const { error } = generateJoi(filter).validate({ field: { nested: 'b' } });

			expect(error?.details[0]?.path).toEqual(['field', 'nested']);
			expect(error?.details[0]?.context?.['validationOperator']).toBe('_eq');
		});

		it(`reports a missing value as required under requireAll`, () => {
			const { error } = generateJoi({ field: { _eq: 'a' } } as FieldFilter, { requireAll: true }).validate({});

			expect(error?.details[0]?.type).toBe('any.required');
		});

		it(`leaves _submitted untagged`, () => {
			const { error } = generateJoi({ field: { _submitted: true } } as unknown as FieldFilter).validate({});

			expect(error?.details).toHaveLength(1);
			expect(error?.details[0]?.context).not.toHaveProperty('validationOperator');
		});
	});
});
