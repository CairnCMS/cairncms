import { defineFlowOperation } from '@cairncms/extensions-server-api';

type Options = {
	text: string;
};

export default defineFlowOperation<Options>({
	id: '__extension_name__',
	handler: async ({ options }, { host }) => {
		await host.log.info(options.text);
		return { message: options.text };
	},
});
