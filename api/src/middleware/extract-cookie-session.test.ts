import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../database/index.js', () => ({
	default: vi.fn(),
	getDatabase: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

vi.mock('../env.js', () => {
	const MOCK_ENV = { REFRESH_TOKEN_COOKIE_NAME: 'cairncms_refresh_token', SECRET: 'test' };
	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

const lookupSessionSpy = vi.fn();

vi.mock('../services/authentication.js', () => ({
	AuthenticationService: vi.fn().mockImplementation(() => ({ lookupSession: lookupSessionSpy })),
}));

const getPermissionsSpy = vi.fn();

vi.mock('../utils/get-permissions.js', () => ({
	getPermissions: getPermissionsSpy,
}));

const { handler } = await import('./extract-cookie-session.js');

const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

const cannedPermissions = [{ collection: 'directus_files', action: 'read' }];

function defaultPublic(): Accountability {
	return { user: null, role: null, admin: false, app: false, ip: '127.0.0.1' };
}

function makeReq(overrides: Partial<Request> = {}): Request {
	return {
		token: null,
		cookies: {},
		schema,
		accountability: defaultPublic(),
		...overrides,
	} as unknown as Request;
}

beforeEach(() => {
	lookupSessionSpy.mockReset();
	getPermissionsSpy.mockReset();
	getPermissionsSpy.mockResolvedValue(cannedPermissions);
});

describe('extract-cookie-session middleware (GHSA-2ccr-g2rv-h677)', () => {
	it('populates accountability and recomputes permissions for an active user with a valid cookie', async () => {
		lookupSessionSpy.mockResolvedValue({
			user_id: 'admin-uuid',
			user_status: 'active',
			role_id: 'admin-role-uuid',
			role_admin_access: true,
			role_app_access: true,
		});

		const req = makeReq({ cookies: { cairncms_refresh_token: 'valid-cookie' } });
		const res = {} as Response;
		const next = vi.fn() as unknown as NextFunction;

		await handler(req, res, next);

		expect(req.accountability!.user).toBe('admin-uuid');
		expect(req.accountability!.role).toBe('admin-role-uuid');
		expect(req.accountability!.admin).toBe(true);
		expect(req.accountability!.app).toBe(true);
		expect(req.accountability!.permissions).toEqual(cannedPermissions);
		expect(getPermissionsSpy).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledOnce();
	});

	it('leaves accountability at default when no cookie is present', async () => {
		const req = makeReq();
		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability).toEqual(defaultPublic());
		expect(lookupSessionSpy).not.toHaveBeenCalled();
		expect(getPermissionsSpy).not.toHaveBeenCalled();
	});

	it('no-ops when a Bearer token is already set', async () => {
		const req = makeReq({ token: 'existing-jwt', cookies: { cairncms_refresh_token: 'valid-cookie' } });
		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability).toEqual(defaultPublic());
		expect(lookupSessionSpy).not.toHaveBeenCalled();
		expect(getPermissionsSpy).not.toHaveBeenCalled();
	});

	it('no-ops when accountability already has a user populated', async () => {
		const req = makeReq({
			accountability: { ...defaultPublic(), user: 'someone-else', role: 'their-role' },
			cookies: { cairncms_refresh_token: 'valid-cookie' },
		});

		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability!.user).toBe('someone-else');
		expect(lookupSessionSpy).not.toHaveBeenCalled();
		expect(getPermissionsSpy).not.toHaveBeenCalled();
	});

	it('leaves accountability at default when lookupSession returns null (expired or invalid)', async () => {
		lookupSessionSpy.mockResolvedValue(null);
		const req = makeReq({ cookies: { cairncms_refresh_token: 'expired' } });
		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability).toEqual(defaultPublic());
		expect(getPermissionsSpy).not.toHaveBeenCalled();
	});

	it('skips populating accountability when the user is suspended', async () => {
		lookupSessionSpy.mockResolvedValue({
			user_id: 'suspended-uuid',
			user_status: 'suspended',
			role_id: 'role-uuid',
			role_admin_access: false,
			role_app_access: true,
		});

		const req = makeReq({ cookies: { cairncms_refresh_token: 'valid-cookie' } });
		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability).toEqual(defaultPublic());
		expect(getPermissionsSpy).not.toHaveBeenCalled();
	});

	it('no-ops when authenticate filter produced a custom accountability', async () => {
		const customAccountability = { admin: true, user: null, role: null, app: false, ip: '127.0.0.1' } as Accountability;

		const req = makeReq({
			accountability: customAccountability,
			cookies: { cairncms_refresh_token: 'valid-cookie' },
		});

		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability).toEqual(customAccountability);
		expect(lookupSessionSpy).not.toHaveBeenCalled();
		expect(getPermissionsSpy).not.toHaveBeenCalled();
	});

	it('populates share accountability fields when the session is a share', async () => {
		lookupSessionSpy.mockResolvedValue({
			share_id: 'share-uuid',
			share_role: 'share-role-uuid',
			share_collection: 'articles',
			share_item: 'article-42',
		});

		const req = makeReq({ cookies: { cairncms_refresh_token: 'valid-share-cookie' } });
		const next = vi.fn() as unknown as NextFunction;

		await handler(req, {} as Response, next);

		expect(req.accountability!.share).toBe('share-uuid');
		expect(req.accountability!.role).toBe('share-role-uuid');
		expect(req.accountability!.share_scope).toEqual({ collection: 'articles', item: 'article-42' });
		expect(req.accountability!.admin).toBe(false);
		expect(req.accountability!.app).toBe(false);
		expect(req.accountability!.permissions).toEqual(cannedPermissions);
		expect(getPermissionsSpy).toHaveBeenCalledOnce();
	});
});
