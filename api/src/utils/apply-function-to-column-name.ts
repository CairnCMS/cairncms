import { getBetweenParens } from '@cairncms/utils';

/**
 * Takes in a column name, and transforms the original name with the generated column name based on
 * the applied function.
 *
 * @example
 *
 * ```js
 * applyFunctionToColumnName('year(date_created)');
 * // => "date_created_year"
 * ```
 */
export function applyFunctionToColumnName(column: string): string {
	if (column.includes('(') && column.includes(')')) {
		const functionName = column.split('(')[0];
		const columnName = getBetweenParens(column);
		if (columnName === null) return column;
		return `${columnName}_${functionName}`;
	} else {
		return column;
	}
}
