import type { Request } from 'express';
import parseurl from 'parseurl';
import type { Url } from 'url';

/** The request target as the router parses it, or `null` when it cannot be parsed. */
export function parseRequestTarget(req: Request): Url | null {
	try {
		return parseurl.original(req) ?? null;
	} catch {
		return null;
	}
}

/**
 * Whether the target parses without being rewritten, so its parsed path and query equal the raw target.
 * The router trims mounted prefixes from the raw target, so only then does its path match the parsed one.
 */
export function isVerbatimTarget(req: Request): boolean {
	const target = parseRequestTarget(req);
	const raw = typeof req.originalUrl === 'string' ? req.originalUrl : req.url;
	return target !== null && target.path === raw;
}
