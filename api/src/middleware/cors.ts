import cors from 'cors';
import type { RequestHandler } from 'express';
import env from '../env.js';
import { CORS_DENY_WITH_VARY, resolveCorsOrigin } from '../utils/cors-origin.js';

let corsMiddleware: RequestHandler = (_req, _res, next) => next();

if (env['CORS_ENABLED'] === true) {
	corsMiddleware = cors({
		origin: (requestOrigin, callback) => {
			const { middlewareOrigin } = resolveCorsOrigin(requestOrigin, env['CORS_ORIGIN']);
			callback(null, middlewareOrigin === CORS_DENY_WITH_VARY ? [] : middlewareOrigin);
		},
		methods: env['CORS_METHODS'] || 'GET,POST,PATCH,DELETE',
		allowedHeaders: env['CORS_ALLOWED_HEADERS'],
		exposedHeaders: env['CORS_EXPOSED_HEADERS'],
		credentials: env['CORS_CREDENTIALS'] || undefined,
		maxAge: env['CORS_MAX_AGE'] || undefined,
	});
}

export default corsMiddleware;
