import type { Application, Request } from 'express';
import type { IncomingMessage } from 'node:http';
import { getEnv } from '../env.js';
import { getTrustProxyFn, resolveClientIp } from './resolve-client-ip.js';

export function getIPForRequest(app: Application, req: IncomingMessage): string {
	const trust = getTrustProxyFn(app);
	const configured = getEnv()['IP_CUSTOM_HEADER'];
	const customHeader = typeof configured === 'string' && configured.length > 0 ? configured : false;

	return resolveClientIp(req, trust, customHeader);
}

export function getIPFromReq(req: Request): string {
	return getIPForRequest(req.app, req);
}
