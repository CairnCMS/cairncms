import { getBetweenParens } from '@cairncms/utils';

/**
 * Strip the function declarations from a list of fields
 */
export function stripFunction(field: string): string {
	if (field.includes('(') && field.includes(')')) {
		return getBetweenParens(field)?.trim() ?? field;
	} else {
		return field;
	}
}
