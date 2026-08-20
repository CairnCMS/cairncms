export interface AdmissionLimits {
	readonly process: number;
	readonly ip: number;
	readonly user: number;
	readonly transports: Readonly<Record<string, number>>;
}

export interface AuthHold {
	clear(): void;
}

export interface Lease {
	beginAuthHold(): AuthHold | null;
	transitionToUser(user: string): boolean;
	transitionToAnonymous(): boolean;
	close(): void;
}

interface LeaseState {
	readonly transport: string;
	readonly ip: string;
	user: string | null;
	hold: AuthHold | null;
	closed: boolean;
	released: boolean;
}

function tryIncrement(map: Map<string, number>, key: string, limit: number): boolean {
	const current = map.get(key) ?? 0;
	if (current >= limit) return false;
	map.set(key, current + 1);
	return true;
}

function decrement(map: Map<string, number>, key: string): void {
	const current = map.get(key) ?? 0;
	if (current <= 1) map.delete(key);
	else map.set(key, current - 1);
}

export class Admission {
	private processCount = 0;
	private readonly perTransport = new Map<string, number>();
	private readonly perIp = new Map<string, number>();
	private readonly perUser = new Map<string, number>();
	private readonly processLimit: number;
	private readonly ipLimit: number;
	private readonly userLimit: number;
	private readonly transportLimits: Map<string, number>;

	constructor(limits: AdmissionLimits) {
		this.processLimit = limits.process;
		this.ipLimit = limits.ip;
		this.userLimit = limits.user;
		this.transportLimits = new Map(Object.entries(limits.transports));
	}

	reserve(transport: string, ip: string): Lease | null {
		const transportLimit = this.transportLimits.get(transport);

		if (transportLimit === undefined) {
			throw new Error(`Unknown WebSocket transport: ${transport}`);
		}

		if (!tryIncrement(this.perTransport, transport, transportLimit)) return null;

		if (this.processCount >= this.processLimit) {
			decrement(this.perTransport, transport);
			return null;
		}

		this.processCount++;

		if (!tryIncrement(this.perIp, ip, this.ipLimit)) {
			this.processCount--;
			decrement(this.perTransport, transport);
			return null;
		}

		return this.createLease({ transport, ip, user: null, hold: null, closed: false, released: false });
	}

	private createLease(state: LeaseState): Lease {
		const release = () => {
			if (state.released) return;
			state.released = true;
			decrement(this.perTransport, state.transport);
			this.processCount--;

			if (state.user !== null) decrement(this.perUser, state.user);
			else decrement(this.perIp, state.ip);
		};

		return {
			beginAuthHold: () => {
				if (state.closed || state.hold !== null) return null;

				const hold: AuthHold = {
					clear: () => {
						if (state.hold !== hold) return;
						state.hold = null;
						if (state.closed) release();
					},
				};

				state.hold = hold;
				return hold;
			},
			transitionToUser: (user: string) => {
				if (state.closed) return false;
				if (state.user === user) return true;
				if (state.user !== null) return false;
				if (!tryIncrement(this.perUser, user, this.userLimit)) return false;

				decrement(this.perIp, state.ip);
				state.user = user;
				return true;
			},
			transitionToAnonymous: () => {
				if (state.closed) return false;
				if (state.user === null) return true;
				if (!tryIncrement(this.perIp, state.ip, this.ipLimit)) return false;

				decrement(this.perUser, state.user);
				state.user = null;
				return true;
			},
			close: () => {
				if (state.released) return;
				state.closed = true;
				if (state.hold !== null) return;
				release();
			},
		};
	}
}
