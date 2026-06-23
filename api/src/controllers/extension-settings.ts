import express from 'express';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { respond } from '../middleware/respond.js';
import { ExtensionSettingsService } from '../services/extension-settings.js';
import asyncHandler from '../utils/async-handler.js';

const router = express.Router();

router.use(
	asyncHandler(async (req, _res, next) => {
		if (req.accountability?.admin !== true) throw new ForbiddenException();
		return next();
	})
);

router.post(
	'/',
	asyncHandler(async (req, res, next) => {
		const { subject, scope, scope_key, key, value } = req.body ?? {};

		if (
			typeof subject !== 'string' ||
			typeof scope !== 'string' ||
			typeof scope_key !== 'string' ||
			typeof key !== 'string'
		) {
			throw new InvalidPayloadException('"subject", "scope", "scope_key", and "key" are required strings.');
		}

		if (value === undefined) throw new InvalidPayloadException('"value" is required.');

		const service = new ExtensionSettingsService({ accountability: req.accountability, schema: req.schema });
		await service.set(subject, scope as 'global' | 'collection', scope_key, key, value);

		res.locals['payload'] = { data: null };
		return next();
	}),
	respond
);

router.get(
	'/',
	asyncHandler(async (req, res, next) => {
		const subject = req.query['subject'];
		if (typeof subject !== 'string') throw new InvalidPayloadException('"subject" is required.');

		const scope = req.query['scope'];

		if (scope !== undefined && scope !== 'global' && scope !== 'collection') {
			throw new InvalidPayloadException('"scope" must be "global" or "collection".');
		}

		const scopeKey = req.query['scope_key'];

		if (scopeKey !== undefined && typeof scopeKey !== 'string') {
			throw new InvalidPayloadException('"scope_key" must be a string.');
		}

		const service = new ExtensionSettingsService({ accountability: req.accountability, schema: req.schema });
		const data = await service.get(subject, scope as 'global' | 'collection' | undefined, scopeKey);

		res.locals['payload'] = { data };
		return next();
	}),
	respond
);

router.delete(
	'/',
	asyncHandler(async (req, res, next) => {
		const subject = req.body?.subject;
		if (typeof subject !== 'string') throw new InvalidPayloadException('"subject" is required.');

		const service = new ExtensionSettingsService({ accountability: req.accountability, schema: req.schema });

		const removed = await service.deleteBySubject(subject);

		res.locals['payload'] = { data: { removed } };
		return next();
	}),
	respond
);

export default router;
