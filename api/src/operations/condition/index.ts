import type { Filter } from '@cairncms/types';
import { defineOperationApi, validatePayload } from '@cairncms/utils';

type Options = {
	filter: Filter;
};

const REPORTED_FAILURE_TYPES = new Map<string, string>([
	['string.icontains', 'string.contains'],
	['string.endsWith', 'string.pattern.name'],
	['string.nendsWith', 'string.pattern.invert.name'],
	['string.istartsWith', 'string.pattern.name'],
	['string.nistartsWith', 'string.pattern.invert.name'],
	['string.iendsWith', 'string.pattern.name'],
	['string.niendsWith', 'string.pattern.invert.name'],
]);

export default defineOperationApi<Options>({
	id: 'condition',

	handler: ({ filter }, { data }) => {
		const errors = validatePayload(filter, data, { requireAll: true });

		if (errors.length === 0) return null;

		throw errors.flatMap((error) =>
			error.details.map((detail) => ({
				path: detail.path,
				type: REPORTED_FAILURE_TYPES.get(detail.type) ?? detail.type,
			}))
		);
	},
});
