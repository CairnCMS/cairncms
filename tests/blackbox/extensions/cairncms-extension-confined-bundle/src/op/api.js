export default {
	id: 'confined-bundle-op',
	handler: async ({ options }) => ({
		marker: 'confined-bundle-op',
		received: options.probe ?? null,
	}),
};
