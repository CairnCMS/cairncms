import type { SchemaOverview } from '@cairncms/types';
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { TokenExpiredException } from '../exceptions/index.js';
import {
	getAnonymousAccountability,
	type RequestAccountability,
	type RequestContext,
} from '../utils/get-anonymous-accountability.js';
import isCairnJWT from '../utils/is-cairncms-jwt.js';
import { getPermissions } from '../utils/get-permissions.js';
import { getStaticIdentityById } from '../utils/get-static-identity.js';
import { getTokenIdentity, type TokenIdentity } from '../utils/get-token-identity.js';
import type { Lease, WorkHold } from './admission.js';
import { getTokenExpiry } from './utils/get-token-expiry.js';

export type AuthReject = 'auth-failed' | 'token-expired' | 'different-user';

export type AuthResult =
	| { status: 'authenticated'; user: string }
	| { status: 'rejected'; reason: AuthReject }
	| { status: 'capacity' }
	| { status: 'busy' }
	| { status: 'superseded' };

export type RevertResult = { status: 'anonymous' } | { status: 'capacity' };

type StaticRevalidation =
	| { status: 'not-static' }
	| { status: 'valid'; identity: TokenIdentity }
	| { status: 'invalid' };

function digestToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export class ConnectionAuth {
	private readonly context: RequestContext;
	private readonly lease: Lease;
	private readonly deps: { database: Knex };

	private accountabilityValue: RequestAccountability;
	private expiryValue: number | null = null;
	private pinnedUser: string | null = null;

	private staticIdentity: { user: string; tokenDigest: string } | null = null;
	private invalidationHandler: (() => void) | null = null;
	private invalidationFired = false;

	private identityEpoch = 0;
	private lookupInFlight = false;
	private closed = false;

	constructor(context: RequestContext, lease: Lease, deps: { database: Knex }) {
		this.context = context;
		this.lease = lease;
		this.deps = deps;
		this.accountabilityValue = getAnonymousAccountability(context);
	}

	get accountability(): RequestAccountability {
		return this.accountabilityValue;
	}

	get expiresAt(): number | null {
		return this.expiryValue;
	}

	get pinned(): boolean {
		return this.pinnedUser !== null;
	}

	setInvalidationHandler(handler: () => void): void {
		this.invalidationHandler = handler;
	}

	async authenticate(token: string): Promise<AuthResult> {
		if (this.closed) return { status: 'superseded' };
		if (this.lookupInFlight) return { status: 'busy' };

		const hold = this.lease.beginWorkHold();
		if (hold === null) throw new Error('WebSocket work hold unavailable for an open connection');

		this.lookupInFlight = true;
		const epoch = this.identityEpoch;

		try {
			let identity: TokenIdentity | null = null;
			let expiry: number | null = null;
			let expired = false;

			try {
				identity = await getTokenIdentity(token, this.deps);
				expiry = getTokenExpiry(token);
			} catch (error) {
				expired = error instanceof TokenExpiredException;
			}

			if (this.closed || this.identityEpoch !== epoch) return { status: 'superseded' };

			if (identity === null || identity.user === undefined) {
				const reason: AuthReject = this.pinned && expired ? 'token-expired' : 'auth-failed';
				return { status: 'rejected', reason };
			}

			const user = identity.user;

			if (this.pinnedUser !== null && this.pinnedUser !== user) {
				return { status: 'rejected', reason: 'different-user' };
			}

			if (!this.lease.transitionToUser(user)) return { status: 'capacity' };

			if (this.pinnedUser === null) this.pinnedUser = user;
			this.accountabilityValue = this.buildAccountability(identity);
			this.expiryValue = expiry;
			this.staticIdentity = isCairnJWT(token) ? null : { user, tokenDigest: digestToken(token) };
			this.invalidationFired = false;
			this.identityEpoch++;
			return { status: 'authenticated', user };
		} finally {
			this.lookupInFlight = false;
			hold.clear();
		}
	}

	async refreshPermissions(schema: SchemaOverview): Promise<boolean> {
		if (this.closed) return false;

		const hold = this.lease.beginWorkHold();
		if (hold === null) return false;

		const epoch = this.identityEpoch;

		try {
			const reval = await this.revalidateStaticIdentity();
			if (this.closed || this.identityEpoch !== epoch) return false;

			if (reval.status === 'invalid') {
				this.fireInvalidation();
				return false;
			}

			const current = this.accountabilityValue;
			const base = reval.status === 'valid' ? this.applyIdentity(current, reval.identity) : current;
			const permissions = await getPermissions(base, schema);

			if (this.closed || this.identityEpoch !== epoch) return false;

			this.accountabilityValue = { ...base, permissions };
			return true;
		} finally {
			hold.clear();
		}
	}

	async snapshotAccountability(schema: SchemaOverview): Promise<RequestAccountability | null> {
		if (this.closed) return null;

		const hold = this.lease.beginWorkHold();
		if (hold === null) return null;

		const epoch = this.identityEpoch;

		try {
			const reval = await this.revalidateStaticIdentity();
			if (this.closed || this.identityEpoch !== epoch) return null;

			if (reval.status === 'invalid') {
				this.fireInvalidation();
				return null;
			}

			const current = this.accountabilityValue;
			const base = reval.status === 'valid' ? this.applyIdentity(current, reval.identity) : current;
			const permissions = await getPermissions(base, schema);

			if (this.closed || this.identityEpoch !== epoch) return null;

			return { ...base, permissions };
		} finally {
			hold.clear();
		}
	}

	revertToAnonymous(): RevertResult {
		if (!this.lease.transitionToAnonymous()) return { status: 'capacity' };

		this.accountabilityValue = getAnonymousAccountability(this.context);
		this.expiryValue = null;
		this.staticIdentity = null;
		this.identityEpoch++;
		return { status: 'anonymous' };
	}

	supersedeToAnonymous(): RevertResult {
		this.identityEpoch++;
		return this.revertToAnonymous();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.identityEpoch++;
		this.lease.close();
	}

	beginWorkHold(): WorkHold | null {
		return this.lease.beginWorkHold();
	}

	private buildAccountability(identity: TokenIdentity): RequestAccountability {
		const accountability = getAnonymousAccountability(this.context);
		Object.assign(accountability, identity);
		return accountability;
	}

	private fireInvalidation(): void {
		if (this.invalidationFired) return;
		this.invalidationFired = true;
		this.invalidationHandler?.();
	}

	private async revalidateStaticIdentity(): Promise<StaticRevalidation> {
		const staticIdentity = this.staticIdentity;
		if (staticIdentity === null) return { status: 'not-static' };

		const row = await getStaticIdentityById(staticIdentity.user, this.deps);

		if (
			row === null ||
			row.status !== 'active' ||
			row.token === null ||
			digestToken(row.token) !== staticIdentity.tokenDigest
		) {
			return { status: 'invalid' };
		}

		return {
			status: 'valid',
			identity: { user: staticIdentity.user, role: row.role, admin: row.admin, app: row.app },
		};
	}

	private applyIdentity(accountability: RequestAccountability, identity: TokenIdentity): RequestAccountability {
		return { ...accountability, role: identity.role, admin: identity.admin, app: identity.app };
	}
}
