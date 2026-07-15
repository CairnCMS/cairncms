import type { Request } from 'express';
import hash from 'object-hash';
import url from 'url';
import { getGraphqlQueryAndVariables } from './get-graphql-query-and-variables.js';
import { isWebhookTriggerPath } from './is-webhook-trigger-route.js';
import { version } from './package.js';

export function getCacheKey(req: Request): string {
	const path = url.parse(req.originalUrl).pathname;
	const isGraphQl = path?.startsWith('/graphql');

	const info: Record<string, unknown> = {
		version,
		user: req.accountability?.user || null,
		role: req.accountability?.role || null,
		admin: req.accountability?.admin || false,
		app: req.accountability?.app || false,
		share: req.accountability?.share || null,
		share_scope: req.accountability?.share_scope || null,
		path,
		query: isGraphQl ? getGraphqlQueryAndVariables(req) : req.sanitizedQuery,
	};

	// A webhook flow response can echo any flow-visible request field ($trigger, $accountability),
	// so it must key on all of them, not just resolved accountability.
	if (isWebhookTriggerPath(path)) {
		info['webhookContext'] = {
			headers: req.headers,
			query: req.query,
			body: req.body,
			ip: req.accountability?.ip ?? null,
			userAgent: req.accountability?.userAgent ?? null,
			origin: req.accountability?.origin ?? null,
		};
	}

	const key = hash(info);
	return key;
}
