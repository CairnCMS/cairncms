import type { NextFunction, Request, Response } from 'express';
import { isEqual } from 'lodash-es';
import getDatabase from '../database/index.js';
import emitter from '../emitter.js';
import asyncHandler from '../utils/async-handler.js';
import { getAnonymousAccountability, type RequestContext } from '../utils/get-anonymous-accountability.js';
import { getIPFromReq } from '../utils/get-ip-from-req.js';
import { getTokenIdentity } from '../utils/get-token-identity.js';

export const handler = async (req: Request, _res: Response, next: NextFunction) => {
	const context: RequestContext = {
		ip: getIPFromReq(req),
		userAgent: req.get('user-agent'),
		origin: req.get('origin'),
	};

	const defaultAccountability = getAnonymousAccountability(context);

	const database = getDatabase();

	const customAccountability = await emitter.emitFilter(
		'authenticate',
		defaultAccountability,
		{
			req,
		},
		{
			database,
			schema: null,
			accountability: null,
		}
	);

	if (customAccountability && isEqual(customAccountability, defaultAccountability) === false) {
		req.accountability = customAccountability;
		return next();
	}

	req.accountability = defaultAccountability;

	if (req.token) {
		Object.assign(defaultAccountability, await getTokenIdentity(req.token, { database }));
	}

	return next();
};

export default asyncHandler(handler);
