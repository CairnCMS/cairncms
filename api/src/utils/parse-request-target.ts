import url, { type UrlWithStringQuery } from 'url';

export function parseRequestTarget(target: string): UrlWithStringQuery | null {
	try {
		return url.parse(target);
	} catch {
		return null;
	}
}
