import type { SchemaOverview } from '@cairncms/types';
import { parseJSON } from '@cairncms/utils';
import type { Knex } from 'knex';
import { getDatabaseClient } from '../database/index.js';
import logger from '../logger.js';
import type { Messenger } from '../messenger.js';
import {
	DELIVERY_CONCURRENCY,
	OUTBOUND_FRAME_CAP,
	OUTBOUND_QUEUE_BYTES,
	SOURCE_EVENT_QUEUE_BYTES,
	SOURCE_EVENT_QUEUE_COUNT,
} from './config.js';
import type { SocketClient } from './controllers/base.js';
import { WebSocketEvent } from './messages.js';
import {
	canonicalItemKey,
	type DispatchBarrier,
	type Reservation,
	type SubscriptionRegistry,
} from './subscriptions.js';
import { resolveTargetService } from './target.js';
import { getEventPayload } from './utils/items.js';
import { deletableKeys, isDeleteFeedEligible } from './utils/removal.js';
import { fmtMessage, safeSend, type OutboundLimits } from './utils/message.js';

const OUTBOUND_LIMITS: OutboundLimits = { frameCap: OUTBOUND_FRAME_CAP, queueByteBound: OUTBOUND_QUEUE_BYTES };

const LOG_OVERLOAD_ENTER = 'WebSocket dispatch entered an overload episode';
const LOG_OVERLOAD_RECOVER = 'WebSocket dispatch recovered from an overload episode';
const LOG_SCHEMA_FAILED = 'WebSocket dispatch could not resolve the schema for an event';

export function resolveDeliveryConcurrency(database?: Knex): number {
	return getDatabaseClient(database) === 'sqlite' ? 1 : DELIVERY_CONCURRENCY;
}

class CancellationToken {
	private readonly controller = new AbortController();

	cancel(): void {
		if (!this.controller.signal.aborted) this.controller.abort();
	}

	get isCancelled(): boolean {
		return this.controller.signal.aborted;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}
}

interface Waiter {
	resolve: (acquired: boolean) => void;
	settled: boolean;
	signal: AbortSignal;
	onAbort: () => void;
}

class Semaphore {
	private permits: number;
	private readonly waiters: Waiter[] = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	acquire(signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return Promise.resolve(false);

		if (this.permits > 0) {
			this.permits--;
			return Promise.resolve(true);
		}

		return new Promise<boolean>((resolve) => {
			const waiter: Waiter = { resolve, settled: false, signal, onAbort: () => undefined };

			waiter.onAbort = () => {
				if (waiter.settled) return;
				waiter.settled = true;
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				resolve(false);
			};

			this.waiters.push(waiter);
			signal.addEventListener('abort', waiter.onAbort, { once: true });
		});
	}

	release(): void {
		const waiter = this.waiters.shift();

		if (waiter === undefined) {
			this.permits++;
			return;
		}

		waiter.settled = true;
		waiter.signal.removeEventListener('abort', waiter.onAbort);
		waiter.resolve(true);
	}
}

interface QueueEntry {
	readonly generation: number;
	readonly barrier: DispatchBarrier;
	readonly encoded: Buffer;
	readonly bytes: number;
	readonly token: CancellationToken;
	released: boolean;
}

export interface DispatchCoordinatorOptions {
	registry: SubscriptionRegistry;
	getSchema: () => Promise<SchemaOverview>;
	messenger: Messenger;
	closeConnection: (client: SocketClient, code?: number) => void;
	deliveryConcurrency: number;
}

export class DispatchCoordinator {
	private readonly registry: SubscriptionRegistry;
	private readonly getSchema: () => Promise<SchemaOverview>;
	private readonly messenger: Messenger;
	private readonly closeConnection: (client: SocketClient, code?: number) => void;
	private readonly semaphore: Semaphore;

	private readonly queues = new Map<string, QueueEntry[]>();
	private readonly workers = new Set<Promise<void>>();
	private queueCount = 0;
	private queueBytes = 0;

	private token = new CancellationToken();
	private overloaded = false;
	private stopped = false;
	private stopPromise: Promise<void> | null = null;

	private readonly onMessage = (message: Record<string, any>): void => this.admit(message);

	constructor(options: DispatchCoordinatorOptions) {
		this.registry = options.registry;
		this.getSchema = options.getSchema;
		this.messenger = options.messenger;
		this.closeConnection = options.closeConnection;
		this.semaphore = new Semaphore(options.deliveryConcurrency);
	}

	start(): void {
		this.messenger.subscribe('websocket.event', this.onMessage);
	}

	private admit(message: Record<string, any>): void {
		if (this.stopped || this.overloaded) return;

		const parsed = WebSocketEvent.safeParse(message);
		if (!parsed.success) return;

		const event = parsed.data;
		const encoded = Buffer.from(JSON.stringify(event));
		const bytes = encoded.length;

		if (this.queueCount + 1 > SOURCE_EVENT_QUEUE_COUNT || this.queueBytes + bytes > SOURCE_EVENT_QUEUE_BYTES) {
			this.enterOverload();
			return;
		}

		const context = this.registry.captureDispatchContext(event.collection);

		const entry: QueueEntry = {
			generation: context.generation,
			barrier: context.barrier,
			encoded,
			bytes,
			token: this.token,
			released: false,
		};

		let queue = this.queues.get(event.collection);

		if (queue === undefined) {
			queue = [];
			this.queues.set(event.collection, queue);
		}

		queue.push(entry);
		this.queueCount++;
		this.queueBytes += bytes;

		if (queue.length === 1) this.spawnWorker(event.collection, queue);
	}

	private spawnWorker(collection: string, queue: QueueEntry[]): void {
		const worker = this.runWorker(collection, queue);
		this.workers.add(worker);

		void worker.finally(() => {
			this.workers.delete(worker);
			this.maybeRecover();
		});
	}

	private async runWorker(collection: string, queue: QueueEntry[]): Promise<void> {
		while (queue.length > 0) {
			const entry = queue[0]!;

			await entry.barrier.wait(entry.token.signal);

			if (!entry.token.isCancelled) {
				await this.fanOut(collection, entry);
			}

			this.releaseEntry(entry);
			queue.shift();
		}

		this.queues.delete(collection);
	}

	private async fanOut(collection: string, entry: QueueEntry): Promise<void> {
		let event: WebSocketEvent;

		try {
			event = WebSocketEvent.parse(parseJSON(entry.encoded.toString()));
		} catch {
			return;
		}

		const recipients = this.registry.getActiveByCollection(collection, entry.generation);
		let schema: SchemaOverview | null = null;
		let schemaResolved = false;

		for (const reservation of recipients) {
			if (entry.token.isCancelled) return;
			if (!reservation.isActive()) continue;

			const { subscription } = reservation;
			if (subscription.event !== undefined && subscription.event !== event.action) continue;
			if (event.action === 'delete' && subscription.event !== 'delete') continue;
			if (subscription.item !== undefined && !this.matchesItem(event, subscription.item)) continue;

			const acquired = await this.semaphore.acquire(entry.token.signal);
			if (!acquired) return;

			try {
				if (entry.token.isCancelled) return;

				if (!schemaResolved) {
					schemaResolved = true;

					try {
						schema = await this.getSchema();
					} catch {
						logger.debug(LOG_SCHEMA_FAILED);
						schema = null;
					}
				}

				if (schema === null) return;

				if (event.action === 'delete') {
					await this.deliverRemoval(reservation, event, schema);
				} else {
					await this.deliver(reservation, event, schema);
				}
			} catch {
				// A single subscriber's failure never stops the others.
			} finally {
				this.semaphore.release();
			}
		}
	}

	private async deliver(reservation: Reservation, event: WebSocketEvent, schema: SchemaOverview): Promise<void> {
		const { subscription } = reservation;
		const { client } = subscription;

		const accountability = await client.auth.snapshotAccountability(schema);
		if (accountability === null) return;

		const service = resolveTargetService(subscription.collection, { schema, accountability });
		if (service === null) return;

		const payload = await getEventPayload(service, subscription, accountability, schema, event);

		const data = payload['data'];
		if (Array.isArray(data) && data.length === 0) return;

		if (!reservation.isActive()) return;

		safeSend(client, fmtMessage('subscription', payload, subscription.uid), OUTBOUND_LIMITS, (code) =>
			this.closeConnection(client, code)
		);
	}

	private async deliverRemoval(
		reservation: Reservation,
		event: Extract<WebSocketEvent, { action: 'delete' }>,
		schema: SchemaOverview
	): Promise<void> {
		const { subscription } = reservation;
		const { client } = subscription;

		const accountability = await client.auth.snapshotAccountability(schema);
		if (accountability === null) return;

		if (!isDeleteFeedEligible(subscription.collection, accountability, schema)) {
			if (reservation.isActive()) reservation.remove();
			return;
		}

		const keys = deletableKeys(subscription.item, event);
		if (keys.length === 0) return;
		if (!reservation.isActive()) return;

		safeSend(
			client,
			fmtMessage('subscription', { event: 'delete', data: keys }, subscription.uid),
			OUTBOUND_LIMITS,
			(code) => this.closeConnection(client, code)
		);
	}

	private matchesItem(event: WebSocketEvent, item: string): boolean {
		return event.action === 'create'
			? canonicalItemKey(event.key) === item
			: event.keys.some((key) => canonicalItemKey(key) === item);
	}

	private releaseEntry(entry: QueueEntry): void {
		if (entry.released) return;
		entry.released = true;
		this.queueCount--;
		this.queueBytes -= entry.bytes;
	}

	private enterOverload(): void {
		if (this.overloaded) return;
		this.overloaded = true;
		this.registry.enterOverload();
		logger.warn(LOG_OVERLOAD_ENTER);

		for (const client of this.registry.getSubscribedOwners()) this.closeConnection(client, 1013);

		this.token.cancel();
		this.maybeRecover();
	}

	private maybeRecover(): void {
		if (!this.overloaded || this.stopped) return;
		if (this.workers.size > 0 || this.queueCount > 0) return;

		this.overloaded = false;
		this.token = new CancellationToken();
		this.registry.exitOverload();
		logger.warn(LOG_OVERLOAD_RECOVER);
	}

	stop(): Promise<void> {
		if (this.stopPromise !== null) return this.stopPromise;
		this.stopPromise = this.doStop();
		return this.stopPromise;
	}

	private async doStop(): Promise<void> {
		this.registry.markUnavailable();
		this.stopped = true;
		this.messenger.unsubscribe('websocket.event', this.onMessage);
		this.token.cancel();

		await Promise.allSettled([...this.workers]);
	}
}
