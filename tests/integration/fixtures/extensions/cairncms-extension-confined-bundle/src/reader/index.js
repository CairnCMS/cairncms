export default {
	id: 'confined-bundle-reader',
	handler: async (request, context) => {
		const reply = await context.host.items.readMany(request.body.collection, request.body.query ?? {});
		return { body: reply };
	},
};
