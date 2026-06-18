export default {
	id: 'cairncms-extension-confined-action-hook',
	actions: {
		'confined_hook_records.items.create': async () => {
			throw new Error('ACTION_MUST_NOT_BLOCK');
		},
	},
};
