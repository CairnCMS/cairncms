import type { Filter } from '@cairncms/types';
import { defineOperationApi, validatePayload } from '@cairncms/utils';

type Options = {
	filter: Filter;
};

export default defineOperationApi<Options>({
	id: 'condition',

	handler: ({ filter }, { data }) => {
		const errors = validatePayload(filter, data, { requireAll: true });

		if (errors.length > 0) {
			throw errors;
		} else {
			return null;
		}
	},
});
