import type { FetchInterface } from '../index.js';
import { extractData } from './extract-data.js';

/**
 * Request helper providing default settings
 *
 * @param url The request URL
 * @param options The request options
 * @param fetcher The fetch implementation
 * @param envelope Whether to return the whole JSON response body instead of its data field
 *
 * @returns The API result if successful
 */
export const request = async <Output = any>(
	url: string,
	options: RequestInit,
	fetcher: FetchInterface = globalThis.fetch,
	envelope = false
): Promise<Output> => {
	options.headers =
		typeof options.headers === 'object' && !Array.isArray(options.headers)
			? (options.headers as Record<string, string>)
			: {};

	return fetcher(url, options).then((response) => {
		return extractData(response, envelope).catch((reason) => {
			const errors = typeof reason === 'object' && 'errors' in reason ? reason.errors : reason;
			return Promise.reject({ errors, response });
		});
	});
};
