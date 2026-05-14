import type { RequestHandler } from 'express';
import env from '../env.js';
import { AuthenticationService } from '../services/authentication.js';
import asyncHandler from '../utils/async-handler.js';
import { getPermissions } from '../utils/get-permissions.js';

export const handler: RequestHandler = async (req, _res, next) => {
	if (req.token) return next();
	if (!req.accountability) return next();

	const isDefaultPublic =
		req.accountability.user === null &&
		req.accountability.role === null &&
		req.accountability.admin === false &&
		req.accountability.app === false &&
		req.accountability.share === undefined;

	if (!isDefaultPublic) return next();

	const cookieName = env['REFRESH_TOKEN_COOKIE_NAME'] as string;
	const refreshToken = req.cookies?.[cookieName];
	if (!refreshToken) return next();

	const authService = new AuthenticationService({ accountability: null, schema: req.schema });
	const record = await authService.lookupSession(refreshToken);
	if (!record) return next();

	if (record.user_id && (record.user_status as string) !== 'active') return next();

	if (record.user_id) {
		req.accountability.user = record.user_id;
		req.accountability.role = record.role_id;
		req.accountability.admin = record.role_admin_access === true || (record.role_admin_access as unknown) === 1;
		req.accountability.app = record.role_app_access === true || (record.role_app_access as unknown) === 1;
	} else if (record.share_id) {
		req.accountability.share = record.share_id;
		req.accountability.role = record.share_role;
		req.accountability.share_scope = { collection: record.share_collection, item: record.share_item };
		req.accountability.app = false;
		req.accountability.admin = false;
	}

	req.accountability.permissions = await getPermissions(req.accountability, req.schema);

	return next();
};

export default asyncHandler(handler);
