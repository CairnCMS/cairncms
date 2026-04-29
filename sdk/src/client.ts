import type { ClientGlobals, ClientOptions, CairnCMSClient } from './types/client.js';

/**
 * The default globals supplied to the client
 */
const defaultGlobals: ClientGlobals = {
	fetch: globalThis.fetch,
	URL: globalThis.URL,
	logger: globalThis.console,
};

/**
 * Creates a client to communicate with a CairnCMS app.
 *
 * @param url The URL to the CairnCMS app.
 * @param config The optional configuration.
 *
 * @returns A CairnCMS client.
 */
export const createCairnCMS = <Schema = any>(url: string, options: ClientOptions = {}): CairnCMSClient<Schema> => {
	const globals = options.globals ? { ...defaultGlobals, ...options.globals } : defaultGlobals;
	return {
		globals,
		url: new globals.URL(url),
		with(createExtension) {
			return {
				...this,
				...createExtension(this),
			};
		},
	};
};
