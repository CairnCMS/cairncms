export default {
	id: 'confined-bundle-hook',
	filters: {
		'confined_bundle_records.items.create': async (payload, _meta, context) => ({
			...payload,
			stamped: 'by-confined-bundle-hook',
			stamped_by: context.accountability ? context.accountability.user : null,
		}),
	},
};
