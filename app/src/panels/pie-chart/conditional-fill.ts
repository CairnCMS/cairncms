import type { StringConditionalFillOperators } from '@/types/panels';

export type ConditionalFillFormat = {
	operator: StringConditionalFillOperators;
	color: string;
	value: string | number;
};

export function checkMatchingConditionalFill(
	value: string | number,
	format: ConditionalFillFormat,
	isNumberColumn: boolean
): boolean {
	let baseValue: string | number = value;
	let compareValue: string | number = format.value;

	if (isNumberColumn) {
		if (isNaN(Number(value)) || isNaN(Number(format.value))) return false;
		baseValue = Number(value);
		compareValue = Number(format.value);
	}

	switch (format.operator || '>=') {
		case '=':
			return baseValue === compareValue;
		case '!=':
			return baseValue !== compareValue;
		case '>':
			return Number(baseValue) > compareValue;
		case '>=':
			return Number(baseValue) >= compareValue;
		case '<':
			return Number(baseValue) < compareValue;
		case '<=':
			return Number(baseValue) <= compareValue;
		case 'contains':
			return typeof baseValue === 'string' && typeof compareValue === 'string'
				? baseValue.includes(compareValue)
				: false;
		case 'ncontains':
			return typeof baseValue === 'string' && typeof compareValue === 'string'
				? !baseValue.includes(compareValue)
				: false;
		case 'starts_with':
			return typeof baseValue === 'string' && typeof compareValue === 'string'
				? baseValue.startsWith(compareValue)
				: false;
		case 'ends_with':
			return typeof baseValue === 'string' && typeof compareValue === 'string'
				? baseValue.endsWith(compareValue)
				: false;
		default:
			return false;
	}
}
