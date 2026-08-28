import type { Permission, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenExpiredException } from '../exceptions/index.js';
import type { RequestContext } from '../utils/get-anonymous-accountability.js';
import type { TokenIdentity } from '../utils/get-token-identity.js';
import { Admission } from './admission.js';
import { ConnectionAuth } from './authenticate.js';

vi.mock('../utils/get-token-identity.js', () => ({ getTokenIdentity: vi.fn() }));
vi.mock('./utils/get-token-expiry.js', () => ({ getTokenExpiry: vi.fn(() => null) }));
vi.mock('../utils/get-permissions.js', () => ({ getPermissions: vi.fn() }));

const { getTokenIdentity } = await import('../utils/get-token-identity.js');
const { getTokenExpiry } = await import('./utils/get-token-expiry.js');
const { getPermissions } = await import('../utils/get-permissions.js');

const resolver = vi.mocked(getTokenIdentity);
const expiry = vi.mocked(getTokenExpiry);
const permissions = vi.mocked(getPermissions);

const CONTEXT: RequestContext = { ip: '1.1.1.1', userAgent: 'agent', origin: null };
const DEPS = { database: {} as Knex };
const SCHEMA = { collections: {}, relations: [] } as unknown as SchemaOverview;

function permission(collection: string): Permission {
	return { collection, action: 'read' } as unknown as Permission;
}

function userIdentity(user: string): TokenIdentity {
	return { user, role: 'role-1', admin: false, app: true };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

function makeAuth(limits: { user?: number; ip?: number } = {}) {
	const admission = new Admission({
		process: 100,
		ip: limits.ip ?? 100,
		user: limits.user ?? 100,
		transports: { rest: 100 },
	});

	const lease = admission.reserve('rest', CONTEXT.ip)!;
	return { admission, lease, auth: new ConnectionAuth(CONTEXT, lease, DEPS) };
}

beforeEach(() => {
	resolver.mockReset();
	expiry.mockReset();
	expiry.mockReturnValue(null);
	permissions.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('ConnectionAuth outcomes', () => {
	it('pins the first user and reports authenticated', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();

		expect(await auth.authenticate('token')).toEqual({ status: 'authenticated', user: 'alice' });
		expect(auth.pinned).toBe(true);
		expect(auth.accountability.user).toBe('alice');
	});

	it('is idempotent for the same user', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();

		await auth.authenticate('token');
		expect(await auth.authenticate('token')).toEqual({ status: 'authenticated', user: 'alice' });
	});

	it('rejects a different user without switching identity', async () => {
		const { auth } = makeAuth();

		resolver.mockResolvedValueOnce(userIdentity('alice'));
		await auth.authenticate('token');

		resolver.mockResolvedValueOnce(userIdentity('bob'));
		expect(await auth.authenticate('token')).toEqual({ status: 'rejected', reason: 'different-user' });
		expect(auth.accountability.user).toBe('alice');
	});

	it('reports capacity and preserves state when the user bucket is full', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { admission, auth } = makeAuth({ user: 1 });
		admission.reserve('rest', '9.9.9.9')!.transitionToUser('alice');

		expect(await auth.authenticate('token')).toEqual({ status: 'capacity' });
		expect(auth.pinned).toBe(false);
		expect(auth.accountability.user).toBeNull();
	});

	it('rejects a userless token with the uniform failure', async () => {
		resolver.mockResolvedValue({ role: 'role-1', admin: false, app: false, share: 'share-1' });
		const { auth } = makeAuth();

		expect(await auth.authenticate('token')).toEqual({ status: 'rejected', reason: 'auth-failed' });
		expect(auth.pinned).toBe(false);
	});

	it('classifies expiry as token-expired only once pinned', async () => {
		const { auth } = makeAuth();

		resolver.mockRejectedValueOnce(new TokenExpiredException());
		expect(await auth.authenticate('token')).toEqual({ status: 'rejected', reason: 'auth-failed' });

		resolver.mockResolvedValueOnce(userIdentity('alice'));
		await auth.authenticate('token');

		resolver.mockRejectedValueOnce(new TokenExpiredException());
		expect(await auth.authenticate('token')).toEqual({ status: 'rejected', reason: 'token-expired' });
	});

	it('sets the expiry from the token when authenticated', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		expiry.mockReturnValue(1234);
		const { auth } = makeAuth();

		await auth.authenticate('token');
		expect(auth.expiresAt).toBe(1234);
	});
});

describe('ConnectionAuth revert', () => {
	it('reverts to anonymous while retaining the pin', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		expect(auth.revertToAnonymous()).toEqual({ status: 'anonymous' });
		expect(auth.accountability.user).toBeNull();
		expect(auth.pinned).toBe(true);
		expect(auth.expiresAt).toBeNull();
	});

	it('reports capacity and preserves authority when the IP bucket is full on revert', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { admission, auth } = makeAuth({ ip: 1 });
		await auth.authenticate('token');
		admission.reserve('rest', CONTEXT.ip);

		expect(auth.revertToAnonymous()).toEqual({ status: 'capacity' });
		expect(auth.accountability.user).toBe('alice');
	});
});

describe('ConnectionAuth concurrency and identity epoch', () => {
	it('returns busy for a concurrent call and starts no second lookup', async () => {
		const gate = deferred<TokenIdentity>();
		resolver.mockReturnValue(gate.promise);
		const { auth } = makeAuth();

		const first = auth.authenticate('token');
		expect(await auth.authenticate('token')).toEqual({ status: 'busy' });
		expect(resolver).toHaveBeenCalledTimes(1);

		gate.resolve(userIdentity('alice'));
		expect(await first).toEqual({ status: 'authenticated', user: 'alice' });
	});

	it('discards a late lookup result after close', async () => {
		const gate = deferred<TokenIdentity>();
		resolver.mockReturnValue(gate.promise);
		const { auth } = makeAuth();

		const first = auth.authenticate('token');
		auth.close();
		gate.resolve(userIdentity('alice'));

		expect(await first).toEqual({ status: 'superseded' });
		expect(auth.accountability.user).toBeNull();
	});

	it('supersedes a public reauthentication so a late success cannot restore authority', async () => {
		resolver.mockResolvedValueOnce(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		const gate = deferred<TokenIdentity>();
		resolver.mockReturnValueOnce(gate.promise);
		const reauth = auth.authenticate('token');

		expect(auth.supersedeToAnonymous()).toEqual({ status: 'anonymous' });
		gate.resolve(userIdentity('alice'));

		expect(await reauth).toEqual({ status: 'superseded' });
		expect(auth.accountability.user).toBeNull();
	});
});

describe('ConnectionAuth closed-state guard', () => {
	it('returns superseded after close, and after repeated close, without calling the resolver', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();

		auth.close();
		auth.close();

		expect(await auth.authenticate('token')).toEqual({ status: 'superseded' });
		expect(resolver).not.toHaveBeenCalled();
	});
});

describe('ConnectionAuth admission reclaim', () => {
	async function reclaimsOnClose(reach: (auth: ConnectionAuth) => Promise<void>) {
		const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 1 } });
		const lease = admission.reserve('rest', CONTEXT.ip)!;
		const auth = new ConnectionAuth(CONTEXT, lease, DEPS);

		await reach(auth);

		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();
		auth.close();
		expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull();
	}

	it('reclaims after an authenticated outcome', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		await reclaimsOnClose((auth) => auth.authenticate('token').then(() => undefined));
	});

	it('reclaims after a rejected outcome', async () => {
		resolver.mockRejectedValue(new Error('bad token'));
		await reclaimsOnClose((auth) => auth.authenticate('token').then(() => undefined));
	});

	it('reclaims after a different-user outcome', async () => {
		await reclaimsOnClose(async (auth) => {
			resolver.mockResolvedValueOnce(userIdentity('alice'));
			await auth.authenticate('token');
			resolver.mockResolvedValueOnce(userIdentity('bob'));
			await auth.authenticate('token');
		});
	});

	it('reclaims the source bucket after a capacity outcome', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const admission = new Admission({ process: 100, ip: 1, user: 1, transports: { rest: 100 } });
		admission.reserve('rest', '9.9.9.9')!.transitionToUser('alice');

		const lease = admission.reserve('rest', CONTEXT.ip)!;
		const auth = new ConnectionAuth(CONTEXT, lease, DEPS);
		expect(await auth.authenticate('token')).toEqual({ status: 'capacity' });

		expect(admission.reserve('rest', CONTEXT.ip)).toBeNull();
		auth.close();
		expect(admission.reserve('rest', CONTEXT.ip)).not.toBeNull();
	});

	it('defers the release across a superseding close until the lookup settles', async () => {
		const gate = deferred<TokenIdentity>();
		resolver.mockReturnValue(gate.promise);
		const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 1 } });

		const lease = admission.reserve('rest', CONTEXT.ip)!;
		const auth = new ConnectionAuth(CONTEXT, lease, DEPS);
		const pending = auth.authenticate('token');
		auth.close();

		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();
		gate.resolve(userIdentity('alice'));
		expect(await pending).toEqual({ status: 'superseded' });
		expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull();
	});
});

describe('ConnectionAuth.refreshPermissions', () => {
	it('installs refreshed permissions while preserving the identity and context', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		permissions.mockResolvedValue([permission('articles')]);

		expect(await auth.refreshPermissions(SCHEMA)).toBe(true);
		expect(auth.accountability.permissions).toEqual([permission('articles')]);
		expect(auth.accountability.user).toBe('alice');
		expect(auth.accountability.ip).toBe(CONTEXT.ip);

		expect(permissions).toHaveBeenCalledWith(
			expect.objectContaining({ user: 'alice', role: 'role-1', app: true, admin: false }),
			SCHEMA
		);
	});

	it('discards the result when the identity epoch changes during the await', async () => {
		const gate = deferred<Permission[]>();
		permissions.mockReturnValue(gate.promise);
		const { auth } = makeAuth();

		const pending = auth.refreshPermissions(SCHEMA);
		auth.supersedeToAnonymous();
		gate.resolve([permission('articles')]);

		expect(await pending).toBe(false);
		expect(auth.accountability.permissions).toBeUndefined();
	});

	it('returns false without loading permissions once closed', async () => {
		const { auth } = makeAuth();
		auth.close();

		expect(await auth.refreshPermissions(SCHEMA)).toBe(false);
		expect(permissions).not.toHaveBeenCalled();
	});
});

describe('ConnectionAuth.snapshotAccountability', () => {
	it('returns an immutable snapshot without mutating the connection accountability', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');
		const before = auth.accountability;

		permissions.mockResolvedValue([permission('articles')]);
		const snapshot = await auth.snapshotAccountability(SCHEMA);

		expect(snapshot).toMatchObject({ user: 'alice', permissions: [permission('articles')] });
		expect(auth.accountability).toBe(before);
		expect(auth.accountability.permissions).toBeUndefined();
	});

	it('discards the snapshot and does not mutate when the accountability is replaced during the await', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		const gate = deferred<Permission[]>();
		permissions.mockReturnValue(gate.promise);
		const pending = auth.snapshotAccountability(SCHEMA);

		auth.supersedeToAnonymous();
		gate.resolve([permission('articles')]);

		expect(await pending).toBeNull();
		expect(auth.accountability.user).toBeNull();
		expect(auth.accountability.permissions).toBeUndefined();
	});

	it('keeps the snapshot when a permission-only refresh runs during the await', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		const gate = deferred<Permission[]>();
		permissions.mockReturnValueOnce(gate.promise).mockResolvedValueOnce([permission('articles')]);

		const pending = auth.snapshotAccountability(SCHEMA);
		await auth.refreshPermissions(SCHEMA);
		gate.resolve([permission('articles')]);

		expect(await pending).toMatchObject({ user: 'alice', permissions: [permission('articles')] });
	});

	it('discards the snapshot when a revert to anonymous runs during the await', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		const gate = deferred<Permission[]>();
		permissions.mockReturnValue(gate.promise);
		const pending = auth.snapshotAccountability(SCHEMA);

		auth.revertToAnonymous();
		gate.resolve([permission('articles')]);

		expect(await pending).toBeNull();
	});

	it('discards the snapshot when a same-user reauthentication commits during the await', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { auth } = makeAuth();
		await auth.authenticate('token');

		const gate = deferred<Permission[]>();
		permissions.mockReturnValue(gate.promise);
		const pending = auth.snapshotAccountability(SCHEMA);

		await auth.authenticate('token');
		gate.resolve([permission('articles')]);

		expect(await pending).toBeNull();
	});

	it('rejects stale work but preserves authority when supersede fails on capacity', async () => {
		resolver.mockResolvedValue(userIdentity('alice'));
		const { admission, auth } = makeAuth({ ip: 1 });
		await auth.authenticate('token');

		admission.reserve('rest', CONTEXT.ip);

		const gate = deferred<Permission[]>();
		permissions.mockReturnValue(gate.promise);
		const pending = auth.snapshotAccountability(SCHEMA);

		expect(auth.supersedeToAnonymous()).toEqual({ status: 'capacity' });
		gate.resolve([permission('articles')]);

		expect(await pending).toBeNull();
		expect(auth.accountability.user).toBe('alice');
	});

	it('reclaims the work hold when the permission lookup rejects', async () => {
		permissions.mockRejectedValue(new Error('lookup failed'));
		const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 1 } });
		const lease = admission.reserve('rest', CONTEXT.ip)!;
		const auth = new ConnectionAuth(CONTEXT, lease, DEPS);

		await expect(auth.snapshotAccountability(SCHEMA)).rejects.toThrow('lookup failed');

		auth.close();
		expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull();
	});
});
