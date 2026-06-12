export default {
	id: 'cairncms-extension-confined-items-system',
	handler: async ({ options }, { host }) => {
		if (options.action === 'readOne') {
			return host.items.readOne(options.collection, options.key, options.query ?? {});
		}

		return host.items.read(options.collection, options.query ?? {});
	},
};
