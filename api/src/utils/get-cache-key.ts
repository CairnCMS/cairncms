import type { Request } from 'express';
import hash from 'object-hash';
import url from 'url';
import { getGraphqlQueryAndVariables } from './get-graphql-query-and-variables.js';
import { version } from './package.js';

export function getCacheKey(req: Request): string {
	const path = url.parse(req.originalUrl).pathname;
	const isGraphQl = path?.startsWith('/graphql');

	const info = {
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

	const key = hash(info);
	return key;
}
