import { parse as parseBytes } from 'bytes';
import type { Request, RequestHandler } from 'express';
import { InvalidConfigException } from '../exceptions/index.js';
import logger from '../logger.js';
import { isUnset } from './parse-config.js';

const DEFAULT_PAYLOAD_LIMIT = 1_048_576;

function resolvePayloadLimit(raw: unknown): number | null {
	if (isUnset(raw)) return DEFAULT_PAYLOAD_LIMIT;

	let value: number | null;

	if (typeof raw === 'number') value = raw;
	else if (typeof raw === 'string') value = parseBytes(raw.trim());
	else value = null;

	if (value === null || !Number.isSafeInteger(value) || value <= 0) return null;

	return value;
}

let warned = false;

export function boundedBodyParser(
	raw: unknown,
	type: string | string[],
	build: (limit: number) => RequestHandler
): RequestHandler {
	const limit = resolvePayloadLimit(raw);

	if (limit !== null) return build(limit);

	if (!warned) {
		warned = true;

		logger.warn('Invalid MAX_PAYLOAD_SIZE. Set a valid size to restore JSON and config YAML requests');
	}

	return (req: Request, _res, next) => {
		// body-parser skips bodies consumed by earlier middleware.
		const alreadyParsed = (req as Request & { _body?: boolean })._body === true;

		if (!alreadyParsed && req.is(type)) {
			return next(new InvalidConfigException('"MAX_PAYLOAD_SIZE" is not a valid size'));
		}

		return next();
	};
}
