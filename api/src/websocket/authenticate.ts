import type { Knex } from 'knex';
import { TokenExpiredException } from '../exceptions/index.js';
import {
	getAnonymousAccountability,
	type RequestAccountability,
	type RequestContext,
} from '../utils/get-anonymous-accountability.js';
import { getTokenIdentity, type TokenIdentity } from '../utils/get-token-identity.js';
import type { Lease } from './admission.js';
import { getTokenExpiry } from './utils/get-token-expiry.js';

export type AuthReject = 'auth-failed' | 'token-expired' | 'different-user';

export type AuthResult =
	| { status: 'authenticated'; user: string }
	| { status: 'rejected'; reason: AuthReject }
	| { status: 'capacity' }
	| { status: 'busy' }
	| { status: 'superseded' };

export type RevertResult = { status: 'anonymous' } | { status: 'capacity' };

export class ConnectionAuth {
	private readonly context: RequestContext;
	private readonly lease: Lease;
	private readonly deps: { database: Knex };

	private accountabilityValue: RequestAccountability;
	private expiryValue: number | null = null;
	private pinnedUser: string | null = null;

	private generation = 0;
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

	async authenticate(token: string): Promise<AuthResult> {
		if (this.closed) return { status: 'superseded' };
		if (this.lookupInFlight) return { status: 'busy' };

		const hold = this.lease.beginAuthHold();
		if (hold === null) throw new Error('WebSocket auth hold unavailable for an open connection');

		this.lookupInFlight = true;
		const generation = this.generation;

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

			if (this.closed || this.generation !== generation) return { status: 'superseded' };

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
			return { status: 'authenticated', user };
		} finally {
			this.lookupInFlight = false;
			hold.clear();
		}
	}

	revertToAnonymous(): RevertResult {
		if (!this.lease.transitionToAnonymous()) return { status: 'capacity' };

		this.accountabilityValue = getAnonymousAccountability(this.context);
		this.expiryValue = null;
		return { status: 'anonymous' };
	}

	supersedeToAnonymous(): RevertResult {
		this.generation++;
		return this.revertToAnonymous();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.generation++;
		this.lease.close();
	}

	private buildAccountability(identity: TokenIdentity): RequestAccountability {
		const accountability = getAnonymousAccountability(this.context);
		Object.assign(accountability, identity);
		return accountability;
	}
}
