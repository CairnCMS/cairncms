var CairnEndpoint = (() => {
	const handler = async (_request, context) => ({
		body: { user: context.accountability ? context.accountability.user : null },
	});

	return { default: { id: 'cairncms-extension-confined-auth-endpoint', handler } };
})();
