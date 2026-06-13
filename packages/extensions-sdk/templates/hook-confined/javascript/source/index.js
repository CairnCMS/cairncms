export default {
	id: '__extension_name__',
	actions: {
		'items.create': async (meta, { host }) => {
			await host.log.info(`item created in ${String(meta.collection)}`);
		},
	},
};
