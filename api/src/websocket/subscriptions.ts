import type { Query } from '@cairncms/types';
import { SUBSCRIPTIONS_PER_CONNECTION, SUBSCRIPTIONS_PER_PROCESS } from './config.js';
import type { SocketClient } from './controllers/base.js';

export type SubscriptionEvent = 'create' | 'update' | 'delete';

export function canonicalItemKey(key: string | number): string {
	return String(key);
}

export interface Subscription {
	client: SocketClient;
	collection: string;
	query: Query;
	uid?: string;
	event?: SubscriptionEvent;
	item?: string;
}

export interface Reservation {
	readonly subscription: Subscription;
	readonly settled: Promise<void>;
	activate(): void;
	remove(): void;
	isActive(): boolean;
}

export interface DispatchBarrier {
	wait(signal: AbortSignal): Promise<void>;
}

export interface DispatchContext {
	readonly generation: number;
	readonly barrier: DispatchBarrier;
}

export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: 'limit' | 'unavailable' };

interface RegisteredReservation extends Reservation {
	readonly generation: number;
	isSettled(): boolean;
	onSettled(listener: () => void): () => void;
}

function waitForSettled(reservations: readonly RegisteredReservation[], signal: AbortSignal): Promise<void> {
	const pending = reservations.filter((reservation) => !reservation.isSettled());
	if (pending.length === 0 || signal.aborted) return Promise.resolve();

	return new Promise<void>((resolve) => {
		let remaining = pending.length;
		const disposers: Array<() => void> = [];

		const finish = () => {
			for (const dispose of disposers) dispose();
			resolve();
		};

		const onAbort = () => finish();
		signal.addEventListener('abort', onAbort, { once: true });
		disposers.push(() => signal.removeEventListener('abort', onAbort));

		for (const reservation of pending) {
			disposers.push(
				reservation.onSettled(() => {
					remaining--;
					if (remaining === 0) finish();
				})
			);
		}
	});
}

export class SubscriptionRegistry {
	private lastGeneration = 0;
	private totalCount = 0;
	private overloaded = false;
	private unavailable = false;
	private readonly byClient = new Map<SocketClient, Set<RegisteredReservation>>();
	private readonly activeByCollection = new Map<string, Set<RegisteredReservation>>();
	private readonly initializingByCollection = new Map<string, Set<RegisteredReservation>>();

	enterOverload(): void {
		this.overloaded = true;
	}

	exitOverload(): void {
		this.overloaded = false;
	}

	markUnavailable(): void {
		this.unavailable = true;
	}

	reserve(subscription: Subscription): ReserveResult {
		if (this.overloaded || this.unavailable) return { ok: false, reason: 'unavailable' };

		const { client, collection } = subscription;

		if ((this.byClient.get(client)?.size ?? 0) >= SUBSCRIPTIONS_PER_CONNECTION) return { ok: false, reason: 'limit' };
		if (this.totalCount >= SUBSCRIPTIONS_PER_PROCESS) return { ok: false, reason: 'limit' };

		const generation = ++this.lastGeneration;

		let status: 'initializing' | 'active' | 'removed' = 'initializing';
		let settledFlag = false;
		let resolveSettled!: () => void;

		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		const settleListeners = new Set<() => void>();

		const notifySettled = () => {
			if (settledFlag) return;
			settledFlag = true;
			resolveSettled();
			for (const listener of settleListeners) listener();
			settleListeners.clear();
		};

		const reservation: RegisteredReservation = {
			subscription,
			settled,
			generation,
			isActive: () => status === 'active',
			isSettled: () => settledFlag,
			onSettled: (listener) => {
				if (settledFlag) {
					listener();
					return () => undefined;
				}

				settleListeners.add(listener);
				return () => settleListeners.delete(listener);
			},
			activate: () => {
				if (status !== 'initializing') return;
				status = 'active';
				this.deleteFrom(this.initializingByCollection, collection, reservation);
				this.addTo(this.activeByCollection, collection, reservation);
				notifySettled();
			},
			remove: () => {
				if (status === 'removed') return;

				this.deleteFrom(
					status === 'active' ? this.activeByCollection : this.initializingByCollection,
					collection,
					reservation
				);

				status = 'removed';
				this.deleteFromClient(client, reservation);
				this.totalCount--;
				notifySettled();
			},
		};

		this.addToClient(client, reservation);
		this.addTo(this.initializingByCollection, collection, reservation);
		this.totalCount++;

		return { ok: true, reservation };
	}

	captureDispatchContext(collection: string): DispatchContext {
		const generation = this.lastGeneration;
		const initializing = this.initializingByCollection.get(collection);
		const pending = initializing ? [...initializing] : [];

		return { generation, barrier: { wait: (signal) => waitForSettled(pending, signal) } };
	}

	getActiveByCollection(collection: string, maxGeneration: number): readonly Reservation[] {
		const active = this.activeByCollection.get(collection);
		if (active === undefined) return [];
		return [...active].filter((reservation) => reservation.generation <= maxGeneration);
	}

	getSubscribedOwners(): readonly SocketClient[] {
		return [...this.byClient.keys()];
	}

	removeByUid(client: SocketClient, uid: string): void {
		const reservations = this.byClient.get(client);
		if (reservations === undefined) return;

		for (const reservation of reservations) {
			if (reservation.subscription.uid === uid) {
				reservation.remove();
				return;
			}
		}
	}

	removeAllForClient(client: SocketClient): void {
		const reservations = this.byClient.get(client);
		if (reservations === undefined) return;
		for (const reservation of [...reservations]) reservation.remove();
	}

	private addToClient(client: SocketClient, reservation: RegisteredReservation): void {
		let reservations = this.byClient.get(client);

		if (reservations === undefined) {
			reservations = new Set();
			this.byClient.set(client, reservations);
		}

		reservations.add(reservation);
	}

	private deleteFromClient(client: SocketClient, reservation: RegisteredReservation): void {
		const reservations = this.byClient.get(client);
		if (reservations === undefined) return;
		reservations.delete(reservation);
		if (reservations.size === 0) this.byClient.delete(client);
	}

	private addTo(
		map: Map<string, Set<RegisteredReservation>>,
		collection: string,
		reservation: RegisteredReservation
	): void {
		let reservations = map.get(collection);

		if (reservations === undefined) {
			reservations = new Set();
			map.set(collection, reservations);
		}

		reservations.add(reservation);
	}

	private deleteFrom(
		map: Map<string, Set<RegisteredReservation>>,
		collection: string,
		reservation: RegisteredReservation
	): void {
		const reservations = map.get(collection);
		if (reservations === undefined) return;
		reservations.delete(reservation);
		if (reservations.size === 0) map.delete(collection);
	}
}
