export default {
	id: 'cairncms-extension-confined-filter-hook',
	filters: {
		'confined_hook_records.items.create': async (payload, _meta, context) => {
			if (payload && payload.explode === true) {
				throw new Error('the confined filter refused this payload');
			}

			return {
				...payload,
				stamped: 'by-confined-hook',
				stamped_by: context.accountability ? context.accountability.user : null,
			};
		},
	},
};
