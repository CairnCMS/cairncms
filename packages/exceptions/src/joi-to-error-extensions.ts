export type ValidationErrorItem = {
	message: string;
	path: (string | number)[];
	type: string;
	context?: { value?: unknown; [key: string]: any } | undefined;
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

export type FailedValidationExtensions = {
	field: ValidationErrorItem['path'][number] | undefined;
	type?: FailedValidationType;
};

/**
 * Converts a Joi validation error item into the details of a failed validation. The details carry no compared or
 * submitted value, and leave `type` unset when the item matches no known rule.
 */
export function joiValidationErrorItemToErrorExtensions(item: ValidationErrorItem): FailedValidationExtensions {
	const extensions: FailedValidationExtensions = {
		field: item.path[0],
	};

	const joiType = item.type;

	if (joiType.endsWith('only')) {
		if (item.context?.['valids'].length > 1) {
			extensions.type = 'in';
		} else {
			const valid = item.context?.['valids'][0];

			if (valid === null) {
				extensions.type = 'null';
			} else if (valid === '') {
				extensions.type = 'empty';
			} else {
				extensions.type = 'eq';
			}
		}
	}

	if (joiType.endsWith('invalid')) {
		if (item.context?.['invalids'].length > 1) {
			extensions.type = 'nin';
		} else {
			const invalid = item.context?.['invalids'][0];

			if (invalid === null) {
				extensions.type = 'nnull';
			} else if (invalid === '') {
				extensions.type = 'nempty';
			} else {
				extensions.type = 'neq';
			}
		}
	}

	if (joiType.endsWith('greater')) extensions.type = 'gt';
	if (joiType.endsWith('min')) extensions.type = 'gte';
	if (joiType.endsWith('less')) extensions.type = 'lt';
	if (joiType.endsWith('max')) extensions.type = 'lte';
	if (joiType.endsWith('contains')) extensions.type = 'contains';
	if (joiType.endsWith('ncontains')) extensions.type = 'ncontains';
	if (joiType.endsWith('required')) extensions.type = 'required';
	if (joiType.endsWith('.pattern.base')) extensions.type = 'regex';

	if (joiType.endsWith('.pattern.name') || joiType.endsWith('.pattern.invert.name')) {
		const name = item.context?.['name'];
		if (isPatternRuleName(name)) extensions.type = name;
	}

	return extensions;
}
