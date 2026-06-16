import { Router } from 'express';
import env from '../env.js';
import { ForbiddenException, RouteNotFoundException } from '../exceptions/index.js';
import { getExtensionManager } from '../extensions.js';
import { respond } from '../middleware/respond.js';
import asyncHandler from '../utils/async-handler.js';
import { getCacheControlHeader } from '../utils/get-cache-headers.js';
import { getMilliseconds } from '../utils/get-milliseconds.js';

const router = Router();

router.get(
	'/',
	asyncHandler(async (req, res, next) => {
		if (req.accountability?.admin !== true) {
			throw new ForbiddenException();
		}

		const extensionManager = getExtensionManager();

		res.locals['payload'] = {
			data: extensionManager.getDiagnostics(),
			meta: { confinedRuntime: extensionManager.getConfinedRuntimeMeta() },
		};

		return next();
	}),
	respond
);

router.get(
	'/sources/:chunk',
	asyncHandler(async (req, res) => {
		const chunk = req.params['chunk'] as string;

		if (chunk.endsWith('.map')) {
			throw new RouteNotFoundException(req.path);
		}

		const extensionManager = getExtensionManager();

		let source: string | null;

		if (chunk === 'index.js') {
			source = extensionManager.getAppExtensions();
		} else {
			source = extensionManager.getAppExtensionChunk(chunk);
		}

		if (source === null) {
			throw new RouteNotFoundException(req.path);
		}

		res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');

		res.setHeader(
			'Cache-Control',
			getCacheControlHeader(req, getMilliseconds(env['EXTENSIONS_CACHE_TTL']), false, false)
		);

		res.setHeader('Vary', 'Origin, Cache-Control');
		res.end(source);
	})
);

export default router;
