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

export interface DispatchContext {
	readonly generation: number;
	readonly barrier: { readonly settled: Promise<void> };
}

interface RegisteredReservation extends Reservation {
	readonly generation: number;
}

export class SubscriptionRegistry {
	private lastGeneration = 0;
	private totalCount = 0;
	private readonly byClient = new Map<SocketClient, Set<RegisteredReservation>>();
	private readonly activeByCollection = new Map<string, Set<RegisteredReservation>>();
	private readonly initializingByCollection = new Map<string, Set<RegisteredReservation>>();

	reserve(subscription: Subscription): Reservation | null {
		const { client, collection } = subscription;

		if ((this.byClient.get(client)?.size ?? 0) >= SUBSCRIPTIONS_PER_CONNECTION) return null;
		if (this.totalCount >= SUBSCRIPTIONS_PER_PROCESS) return null;

		const generation = ++this.lastGeneration;

		let status: 'initializing' | 'active' | 'removed' = 'initializing';
		let resolveSettled!: () => void;

		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		const reservation: RegisteredReservation = {
			subscription,
			settled,
			generation,
			isActive: () => status === 'active',
			activate: () => {
				if (status !== 'initializing') return;
				status = 'active';
				this.deleteFrom(this.initializingByCollection, collection, reservation);
				this.addTo(this.activeByCollection, collection, reservation);
				resolveSettled();
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
				resolveSettled();
			},
		};

		this.addToClient(client, reservation);
		this.addTo(this.initializingByCollection, collection, reservation);
		this.totalCount++;

		return reservation;
	}

	captureDispatchContext(collection: string): DispatchContext {
		const generation = this.lastGeneration;
		const initializing = this.initializingByCollection.get(collection);

		const settled =
			initializing && initializing.size > 0
				? Promise.all([...initializing].map((reservation) => reservation.settled)).then(() => undefined)
				: Promise.resolve();

		return { generation, barrier: { settled } };
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
