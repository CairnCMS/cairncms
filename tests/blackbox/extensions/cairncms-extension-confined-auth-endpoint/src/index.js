export default {
	id: 'cairncms-extension-confined-auth-endpoint',
	handler: async (_request, context) => ({
		body: { user: context.accountability ? context.accountability.user : null },
	}),
};
