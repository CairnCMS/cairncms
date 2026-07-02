export default {
	id: 'confined-bundle-op',
	handler: async ({ options }) => ({
		marker: 'confined-bundle-op',
		received: options.probe ?? null,
		apiKeyKind: options.api_key ? (options.api_key.kind ?? typeof options.api_key) : null,
	}),
};
