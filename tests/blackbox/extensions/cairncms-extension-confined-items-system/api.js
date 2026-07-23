var CairnOperation = (() => {
	const handler = async ({ options }, { host }) => {
		if (options.action === 'readOne') {
			return host.items.readOne(options.collection, options.key, options.query ?? {});
		}

		return host.items.readMany(options.collection, options.query ?? {});
	};

	return { default: { id: 'cairncms-extension-confined-items-system', handler } };
})();
