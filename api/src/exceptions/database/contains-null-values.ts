import { BaseException } from '@cairncms/exceptions';

type Exceptions = {
	collection: string;
	field: string;
};

export class ContainsNullValuesException extends BaseException<Partial<Exceptions>> {
	constructor(field: string, exceptions?: Exceptions) {
		super(`Field "${field}" contains null values.`, 400, 'CONTAINS_NULL_VALUES', exceptions);
	}
}
