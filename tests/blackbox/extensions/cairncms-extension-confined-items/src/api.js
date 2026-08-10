export default {
	id: 'cairncms-extension-confined-items',
	handler: async ({ options }, { host }) => {
		switch (options.action) {
			case 'readOne':
				return host.items.readOne(options.collection, options.key, options.query ?? {});
			case 'createOne':
				return host.items.createOne(options.collection, options.payload);
			case 'createMany':
				return host.items.createMany(options.collection, options.payloads);
			case 'updateOne':
				return host.items.updateOne(options.collection, options.key, options.payload);
			case 'updateMany':
				return host.items.updateMany(options.collection, options.keys, options.payload);
			case 'deleteOne':
				return host.items.deleteOne(options.collection, options.key);
			case 'deleteMany':
				return host.items.deleteMany(options.collection, options.keys);
			case 'read':
			case 'readMany':
				return host.items.readMany(options.collection, options.query ?? {});
			default:
				throw new Error(`Unsupported items probe action: ${options.action}`);
		}
	},
};
