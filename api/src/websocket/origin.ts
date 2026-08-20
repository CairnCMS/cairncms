import type { Application } from 'express';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { getEnv } from '../env.js';
import { resolveCorsOrigin } from '../utils/cors-origin.js';
import { getTrustProxyFn } from '../utils/resolve-client-ip.js';
import { Url } from '../utils/url.js';

export function createUpgradeOriginPredicate(): (app: Application, req: IncomingMessage) => boolean {
	const publicUrlOrigin = resolvePublicUrlOrigin();

	return (app, req) => {
		try {
			return decide(app, req, publicUrlOrigin);
		} catch {
			return false;
		}
	};
}

function decide(app: Application, req: IncomingMessage, publicUrlOrigin: string | null): boolean {
	const origins = req.headersDistinct?.['origin'];
	if (origins === undefined || origins.length === 0) return true;
	if (origins.length > 1) return false;

	const rawOrigin = origins[0]!;

	let parsed: URL;

	try {
		parsed = new URL(rawOrigin);
	} catch {
		return false;
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

	const serverOrigin = publicUrlOrigin ?? deriveServerOrigin(app, req);
	if (serverOrigin !== null && parsed.origin === serverOrigin) return true;

	const env = getEnv();
	const corsActive = env['CORS_ENABLED'] === true && env['CORS_ORIGIN'] !== false;
	if (!corsActive) return false;

	return resolveCorsOrigin(rawOrigin, env['CORS_ORIGIN']).allowed;
}

function deriveServerOrigin(app: Application, req: IncomingMessage): string | null {
	const host = req.headers.host;
	if (typeof host !== 'string' || host.length === 0) return null;

	try {
		return new URL(`${requestScheme(app, req)}://${host}`).origin;
	} catch {
		return null;
	}
}

function requestScheme(app: Application, req: IncomingMessage): string {
	const encrypted = 'encrypted' in req.socket && (req.socket as TLSSocket).encrypted === true;
	const base = encrypted ? 'https' : 'http';

	if (!getTrustProxyFn(app)(req.socket.remoteAddress ?? '', 0)) return base;

	const forwarded = req.headers['x-forwarded-proto'];
	const header = typeof forwarded === 'string' && forwarded.length > 0 ? forwarded : base;

	return header.split(',')[0]!.trim();
}

function resolvePublicUrlOrigin(): string | null {
	const publicUrl = getEnv()['PUBLIC_URL'];
	if (typeof publicUrl !== 'string' || !new Url(publicUrl).isAbsolute()) return null;

	return new URL(publicUrl).origin;
}
