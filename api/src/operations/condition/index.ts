import type { Filter } from '@cairncms/types';
import { defineOperationApi, validatePayload } from '@cairncms/utils';

type Options = {
	filter: Filter;
};

export default defineOperationApi<Options>({
	id: 'condition',

	handler: ({ filter }, { data }) => {
		const errors = validatePayload(filter, data, { requireAll: true });

		if (errors.length === 0) return null;

		throw errors.flatMap((error) =>
			error.details.map((detail) => ({
				path: detail.path,
				type: detail.type,
			}))
		);
	},
});
