import { describe, expect, it } from 'vitest';
import { getFilterOperatorsForType } from './get-filter-operators-for-type.js';

describe('', () => {
	it('returns the filter operators for alias', () => {
		expect(getFilterOperatorsForType('alias')).toStrictEqual([
			'contains',
			'ncontains',
			'eq',
			'neq',
			'lt',
			'lte',
			'gt',
			'gte',
			'between',
			'nbetween',
			'empty',
			'nempty',
			'null',
			'nnull',
			'in',
			'nin',
		]);
	});

	it('returns the filter operators for boolean', () => {
		expect(getFilterOperatorsForType('boolean')).toStrictEqual(['eq', 'neq', 'null', 'nnull']);
	});

	it('returns the filter operators for dateTime', () => {
		expect(getFilterOperatorsForType('dateTime')).toStrictEqual([
			'eq',
			'neq',
			'lt',
			'lte',
			'gt',
			'gte',
			'between',
			'nbetween',
			'null',
			'nnull',
			'in',
			'nin',
		]);
	});

	it('returns the filter operators for float', () => {
		expect(getFilterOperatorsForType('float')).toStrictEqual([
			'eq',
			'neq',
			'lt',
			'lte',
			'gt',
			'gte',
			'between',
			'nbetween',
			'null',
			'nnull',
			'in',
			'nin',
		]);
	});

	it('returns the filter operators for integer', () => {
		expect(getFilterOperatorsForType('integer')).toStrictEqual([
			'eq',
			'neq',
			'lt',
			'lte',
			'gt',
			'gte',
			'between',
			'nbetween',
			'null',
			'nnull',
			'in',
			'nin',
		]);
	});

	it('returns the filter operators for json', () => {
		expect(getFilterOperatorsForType('json')).toStrictEqual(['null', 'nnull']);
	});

	it('returns the filter operators for binary', () => {
		expect(getFilterOperatorsForType('binary')).toStrictEqual([
			'contains',
			'ncontains',
			'icontains',
			'starts_with',
			'nstarts_with',
			'istarts_with',
			'nistarts_with',
			'ends_with',
			'nends_with',
			'iends_with',
			'niends_with',
			'eq',
			'neq',
			'empty',
			'nempty',
			'null',
			'nnull',
			'in',
			'nin',
		]);
	});

	it('returns the filter operators for geometry', () => {
		expect(getFilterOperatorsForType('geometry')).toStrictEqual([
			'eq',
			'neq',
			'null',
			'nnull',
			'intersects',
			'nintersects',
			'intersects_bbox',
			'nintersects_bbox',
		]);
	});

	it('returns the geometry filter operators for typed geometry fields', () => {
		const operators = [
			'eq',
			'neq',
			'null',
			'nnull',
			'intersects',
			'nintersects',
			'intersects_bbox',
			'nintersects_bbox',
		];

		for (const type of [
			'geometry.Point',
			'geometry.LineString',
			'geometry.Polygon',
			'geometry.MultiPoint',
			'geometry.MultiLineString',
			'geometry.MultiPolygon',
		] as const) {
			expect(getFilterOperatorsForType(type)).toStrictEqual(operators);
		}
	});

	it('includes validation only types', () => {
		expect(getFilterOperatorsForType('alias', { includeValidation: true })).toStrictEqual([
			'contains',
			'ncontains',
			'eq',
			'neq',
			'lt',
			'lte',
			'gt',
			'gte',
			'between',
			'nbetween',
			'empty',
			'nempty',
			'null',
			'nnull',
			'in',
			'nin',
			'regex',
		]);
	});
});

describe('case-insensitive starts and ends operators by column type', () => {
	const operators = ['istarts_with', 'nistarts_with', 'iends_with', 'niends_with'];

	it.each([
		['binary', 'blob'],
		['binary', 'varbinary'],
		['string', 'interval'],
		['csv', 'ARRAY'],
		['csv', 'character varying[]'],
		['string', null],
	] as const)('leaves them out for a %s field stored as %s', (type, dbType) => {
		const offered = getFilterOperatorsForType(type, { dbType });

		expect(offered.filter((operator) => operators.includes(operator))).toEqual([]);
		expect(offered).toContain('starts_with');
	});

	it.each([
		['string', 'varchar(255)'],
		['string', 'character varying'],
		['string', 'CHAR'],
		['text', 'longtext'],
		['text', 'citext'],
		['csv', 'text'],
	] as const)('offers them for a %s field stored as %s', (type, dbType) => {
		expect(getFilterOperatorsForType(type, { dbType })).toEqual(getFilterOperatorsForType(type));
	});

	it('offers them when the column type is not given', () => {
		expect(getFilterOperatorsForType('binary')).toEqual(expect.arrayContaining(operators));
	});
});
