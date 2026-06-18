export default {
	id: '__extension_name__',
	handler: async ({ options }, { host }) => {
		await host.log.info(options.text);
		return { message: options.text };
	},
};
