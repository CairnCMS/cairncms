import type { Request } from 'express';
import { getEnv } from '../env.js';
import { getTrustProxyFn, resolveClientIp } from './resolve-client-ip.js';

export function getIPFromReq(req: Request): string {
	const trust = getTrustProxyFn(req.app);
	const configured = getEnv()['IP_CUSTOM_HEADER'];
	const customHeader = typeof configured === 'string' && configured.length > 0 ? configured : false;

	return resolveClientIp(req, trust, customHeader);
}
