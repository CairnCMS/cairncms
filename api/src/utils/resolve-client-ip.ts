import type { Application } from 'express';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';
import { canonicalizeIp } from './canonicalize-ip.js';

export type TrustProxyFn = (address: string, hop: number) => boolean;

/** Express stores its compiled trust predicate under an internal setting. Fail closed if it is unavailable. */
export function getTrustProxyFn(app: Application): TrustProxyFn {
	const fn = app.get('trust proxy fn');

	if (typeof fn !== 'function') {
		throw new Error('Express trust proxy function is unavailable');
	}

	return fn as TrustProxyFn;
}

export function resolveClientIp(req: IncomingMessage, trust: TrustProxyFn, customHeaderName: string | false): string {
	let ip = proxyaddr(req, trust);

	if (customHeaderName) {
		const peer = req.socket.remoteAddress;
		const value = req.headers[customHeaderName.toLowerCase()];

		if (peer !== undefined && trust(peer, 0) && typeof value === 'string' && isIP(value) !== 0) {
			ip = value;
		}
	}

	return canonicalizeIp(ip);
}
