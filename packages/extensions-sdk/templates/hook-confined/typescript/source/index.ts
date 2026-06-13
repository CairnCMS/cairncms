import { defineEventHook } from '@cairncms/extensions-server-api';

export default defineEventHook({
	id: '__extension_name__',
	actions: {
		'items.create': async (meta, { host }) => {
			await host.log.info(`item created in ${String(meta['collection'])}`);
		},
	},
});
