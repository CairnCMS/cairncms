import type { Request } from 'express';
import { getAnonymousAccountability, type RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import { getIPFromReq } from '../../utils/get-ip-from-req.js';

export function authenticationAccountabilityFromRequest(req: Request | undefined): RequestAccountability {
	if (!req) {
		throw new Error('GraphQL authentication requires request context');
	}

	return getAnonymousAccountability({
		ip: getIPFromReq(req),
		userAgent: req.get('user-agent'),
		origin: req.get('origin'),
	});
}
