import { getEndpoint } from '@cairncms/utils';
import type { Request } from 'express';
import { getEnv } from '../env.js';
import { parseRequestTarget } from './parse-request-target.js';
import { Url } from './url.js';

export function shouldSkipCache(req: Request): boolean {
	const env = getEnv();

	const target = parseRequestTarget(req.originalUrl);

	if (target === null) return true;

	const referer = req.get('Referer');

	if (referer) {
		const adminUrl = new Url(env['PUBLIC_URL']).addPath('admin');

		if (adminUrl.isRootRelative()) {
			let refererUrl: Url | null = null;

			try {
				refererUrl = new Url(referer);
			} catch {
				refererUrl = null;
			}

			if (refererUrl && refererUrl.path.join('/').startsWith(adminUrl.path.join('/')) && checkAutoPurge()) {
				return true;
			}
		} else if (referer.startsWith(adminUrl.toString()) && checkAutoPurge()) {
			return true;
		}
	}

	if (env['CACHE_SKIP_ALLOWED'] && req.get('cache-control')?.includes('no-store')) return true;

	return false;

	function checkAutoPurge() {
		if (env['CACHE_AUTO_PURGE'] === false) return true;

		const path = target?.pathname;

		if (!path) return false;

		for (const collection of env['CACHE_AUTO_PURGE_IGNORE_LIST']) {
			const ignoredPath = getEndpoint(collection);

			if (path === ignoredPath || path.startsWith(`${ignoredPath}/`)) {
				return true;
			}
		}

		return false;
	}
}
