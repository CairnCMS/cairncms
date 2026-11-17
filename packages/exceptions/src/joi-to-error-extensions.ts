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
	| 'regex';

export type FailedValidationExtensions = {
	field: ValidationErrorItem['path'][number] | undefined;
	type?: FailedValidationType;
	valid?: unknown;
	invalid?: unknown;
	substring?: string;
};

/** Converts a Joi validation error item into the details of a failed validation, leaving `type` unset when the item matches no known rule. */
export function joiValidationErrorItemToErrorExtensions(item: ValidationErrorItem): FailedValidationExtensions {
	const extensions: FailedValidationExtensions = {
		field: item.path[0],
	};

	const joiType = item.type;

	if (joiType.endsWith('only')) {
		if (item.context?.['valids'].length > 1) {
			extensions.type = 'in';
			extensions.valid = item.context?.['valids'];
		} else {
			const valid = item.context?.['valids'][0];

			if (valid === null) {
				extensions.type = 'null';
			} else if (valid === '') {
				extensions.type = 'empty';
			} else {
				extensions.type = 'eq';
				extensions.valid = item.context?.['valids'][0];
			}
		}
	}

	if (joiType.endsWith('invalid')) {
		if (item.context?.['invalids'].length > 1) {
			extensions.type = 'nin';
			extensions.invalid = item.context?.['invalids'];
		} else {
			const invalid = item.context?.['invalids'][0];

			if (invalid === null) {
				extensions.type = 'nnull';
			} else if (invalid === '') {
				extensions.type = 'nempty';
			} else {
				extensions.type = 'neq';
				extensions.invalid = invalid;
			}
		}
	}

	if (joiType.endsWith('greater')) {
		extensions.type = 'gt';
		extensions.valid = item.context?.['limit'];
	}

	if (joiType.endsWith('min')) {
		extensions.type = 'gte';
		extensions.valid = item.context?.['limit'];
	}

	if (joiType.endsWith('less')) {
		extensions.type = 'lt';
		extensions.valid = item.context?.['limit'];
	}

	if (joiType.endsWith('max')) {
		extensions.type = 'lte';
		extensions.valid = item.context?.['limit'];
	}

	if (joiType.endsWith('contains')) {
		extensions.type = 'contains';
		extensions.substring = item.context?.['substring'];
	}

	if (joiType.endsWith('ncontains')) {
		extensions.type = 'ncontains';
		extensions.substring = item.context?.['substring'];
	}

	if (joiType.endsWith('required')) {
		extensions.type = 'required';
	}

	if (joiType.endsWith('.pattern.base')) {
		extensions.type = 'regex';
		extensions.invalid = item.context?.value;
	}

	return extensions;
}
