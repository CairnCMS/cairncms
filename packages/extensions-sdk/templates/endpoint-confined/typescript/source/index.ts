import { defineJsonEndpoint } from '@cairncms/extensions-server-api';

export default defineJsonEndpoint({
	id: '__extension_name__',
	handler: async (request, { host }) => {
		await host.log.info(`handled ${request.method} ${request.path}`);
		return { body: { greeting: 'hello' } };
	},
});
