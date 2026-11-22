import type { ClientFilterOperator, Type } from '@cairncms/types';

type GetFilterOperationsForTypeOptions = {
	includeValidation?: boolean;
	/** The column's database type. When given, operators that need a character column are left out for any other column. */
	dbType?: string | null;
};

const CHARACTER_DB_TYPES = new Set([
	'char',
	'character',
	'bpchar',
	'nchar',
	'varchar',
	'character varying',
	'nvarchar',
	'longvarchar',
	'varchar2',
	'text',
	'tinytext',
	'mediumtext',
	'longtext',
	'ntext',
	'clob',
	'citext',
	'string',
]);

/** Whether a column's database type holds character data, which `LOWER()` lowercases as text. */
function isCharacterDbType(dbType: string | null): boolean {
	return dbType !== null && CHARACTER_DB_TYPES.has(dbType.toLowerCase().split('(')[0]!);
}

export function getFilterOperatorsForType(
	type: Type,
	opts?: GetFilterOperationsForTypeOptions
): ClientFilterOperator[] {
	const validationOnlyStringFilterOperators: ClientFilterOperator[] = opts?.includeValidation ? ['regex'] : [];
	const characterColumn = opts?.dbType === undefined || isCharacterDbType(opts.dbType);
	const prefixOperators: ClientFilterOperator[] = characterColumn ? ['istarts_with', 'nistarts_with'] : [];
	const suffixOperators: ClientFilterOperator[] = characterColumn ? ['iends_with', 'niends_with'] : [];

	if (type.startsWith('geometry')) {
		return ['eq', 'neq', 'null', 'nnull', 'intersects', 'nintersects', 'intersects_bbox', 'nintersects_bbox'];
	}

	switch (type) {
		// Text
		case 'binary':
		case 'string':
		case 'text':
		case 'csv':
			return [
				'contains',
				'ncontains',
				'icontains',
				'starts_with',
				'nstarts_with',
				...prefixOperators,
				'ends_with',
				'nends_with',
				...suffixOperators,
				'eq',
				'neq',
				'empty',
				'nempty',
				'null',
				'nnull',
				'in',
				'nin',
				...validationOnlyStringFilterOperators,
			];
		// Hash
		case 'hash':
			return ['empty', 'nempty', 'null', 'nnull'];
		// JSON
		// UUID
		case 'uuid':
			return ['eq', 'neq', 'null', 'nnull', 'in', 'nin'];
		case 'json':
			return ['null', 'nnull'];

		// Boolean
		case 'boolean':
			return ['eq', 'neq', 'null', 'nnull'];

		// Numbers
		case 'bigInteger':
		case 'integer':
		case 'decimal':
		case 'float':
			return ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'nbetween', 'null', 'nnull', 'in', 'nin'];

		// Datetime
		case 'dateTime':
		case 'date':
		case 'time':
			return ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'nbetween', 'null', 'nnull', 'in', 'nin'];

		default:
			return [
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
				...validationOnlyStringFilterOperators,
			];
	}
}
