export type ValidationErrorItem = {
	message: string;
	path: (string | number)[];
	type: string;
	context?: { value?: unknown; validationOperator?: unknown; [key: string]: any } | undefined;
};

export type FailedValidationType =
	| 'eq'
	| 'neq'
	| 'in'
	| 'nin'
	| 'null'
	| 'nnull'
	| 'empty'
	| 'nempty'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'contains'
	| 'ncontains'
	| 'required'
	| 'regex'
	| PatternRuleName;

const PATTERN_RULE_NAMES = ['starts_with', 'nstarts_with', 'ends_with', 'nends_with'] as const;

type PatternRuleName = (typeof PATTERN_RULE_NAMES)[number];

function isPatternRuleName(name: unknown): name is PatternRuleName {
	return (PATTERN_RULE_NAMES as readonly unknown[]).includes(name);
}

const ONLY_OPERATOR_TYPES = new Map<unknown, FailedValidationType>([
	['_eq', 'eq'],
	['_in', 'in'],
	['_null', 'null'],
	['_empty', 'empty'],
]);

const INVALID_OPERATOR_TYPES = new Map<unknown, FailedValidationType>([
	['_neq', 'neq'],
	['_nin', 'nin'],
	['_nnull', 'nnull'],
	['_nempty', 'nempty'],
]);

const AUTHORED_OPERATOR_TYPES = new Map<unknown, FailedValidationType>([
	['_contains', 'contains'],
	['_icontains', 'contains'],
	['_ncontains', 'ncontains'],
	['_starts_with', 'starts_with'],
	['_nstarts_with', 'nstarts_with'],
	['_ends_with', 'ends_with'],
	['_nends_with', 'nends_with'],
	['_regex', 'regex'],
	['_gt', 'gt'],
	['_gte', 'gte'],
	['_lt', 'lt'],
	['_lte', 'lte'],
]);

const RANGE_OPERATORS = new Set<unknown>(['_between', '_nbetween']);

export type FailedValidationExtensions = {
	field: ValidationErrorItem['path'][number] | undefined;
	type?: FailedValidationType;
};

/**
 * Converts a Joi validation error item into the details of a failed validation. The details carry no compared or
 * submitted value, and leave `type` unset when the item matches no known rule. Equality, membership, null, and empty
 * failures take their `type` from the `validationOperator` the schema recorded, never from the compared values. Every
 * other failure of a text or comparison rule takes the rule's own type, and a range failure takes none, so the
 * details do not depend on the compared value's kind. A missing required value is reported as required.
 */
export function joiValidationErrorItemToErrorExtensions(item: ValidationErrorItem): FailedValidationExtensions {
	const extensions: FailedValidationExtensions = {
		field: item.path[0],
	};

	const joiType = item.type;
	const operator = item.context?.validationOperator;

	if (joiType.endsWith('required')) {
		extensions.type = 'required';
		return extensions;
	}

	if (RANGE_OPERATORS.has(operator)) return extensions;

	const authoredType = AUTHORED_OPERATOR_TYPES.get(operator);

	if (authoredType) {
		extensions.type = authoredType;
		return extensions;
	}

	if (joiType.endsWith('only')) {
		const type = ONLY_OPERATOR_TYPES.get(operator);
		if (type) extensions.type = type;
	}

	if (joiType.endsWith('invalid')) {
		const type = INVALID_OPERATOR_TYPES.get(operator);
		if (type) extensions.type = type;
	}

	if (joiType.endsWith('greater')) extensions.type = 'gt';
	if (joiType.endsWith('min')) extensions.type = 'gte';
	if (joiType.endsWith('less')) extensions.type = 'lt';
	if (joiType.endsWith('max')) extensions.type = 'lte';
	if (joiType.endsWith('contains')) extensions.type = 'contains';
	if (joiType.endsWith('ncontains')) extensions.type = 'ncontains';
	if (joiType.endsWith('.pattern.base')) extensions.type = 'regex';

	if (joiType.endsWith('.pattern.name') || joiType.endsWith('.pattern.invert.name')) {
		const name = item.context?.['name'];
		if (isPatternRuleName(name)) extensions.type = name;
	}

	return extensions;
}
