import type { Accountability } from '@cairncms/types';
import type { Request } from 'express';
import { getIPFromReq } from '../../utils/get-ip-from-req.js';

export function authenticationAccountabilityFromRequest(req: Request | undefined): Accountability {
	if (!req) {
		throw new Error('GraphQL authentication requires request context');
	}

	const accountability: Accountability = { role: null, ip: getIPFromReq(req) };

	const userAgent = req.get('user-agent');
	if (userAgent) accountability.userAgent = userAgent;

	const origin = req.get('origin');
	if (origin) accountability.origin = origin;

	return accountability;
}
