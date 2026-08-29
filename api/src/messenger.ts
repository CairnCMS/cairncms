import { parseJSON } from '@cairncms/utils';
import { Redis, type RedisOptions } from 'ioredis';
import env from './env.js';
import logger from './logger.js';
import { getConfigFromEnv } from './utils/get-config-from-env.js';

const COMMAND_DEADLINE_MS = 5_000;
const PROBE_CHANNEL = 'messenger-probe';

export const MESSENGER_UNAVAILABLE =
	'The messenger connection is unavailable, so cross-instance cache and flow changes will not propagate until it recovers.';

export const MESSENGER_RECOVERED = 'The messenger connection recovered.';

export const MESSENGER_CONFIG_INVALID =
	'The messenger Redis configuration is invalid, so cross-instance cache and flow changes will not propagate. Correct the configuration and restart the API.';

export const MESSENGER_CALLBACK_FAILED = 'A messenger subscription callback failed.';

const FAIL_CLOSED_OPTIONS: RedisOptions = {
	enableOfflineQueue: false,
	autoResendUnfulfilledCommands: false,
	maxRetriesPerRequest: 0,
	autoResubscribe: false,
};

export type MessengerStatus = 'available' | 'unavailable';

export type MessengerSubscriptionCallback = (payload: Record<string, any>) => void | Promise<void>;

export interface Messenger {
	publish: (channel: string, payload: Record<string, any>) => void;
	subscribe: (channel: string, callback: MessengerSubscriptionCallback) => void;
	unsubscribe: (channel: string, callback: MessengerSubscriptionCallback) => void;
	getStatus: () => MessengerStatus;
}

/** One failing callback must not stop the others, and an async callback's rejection must not go unhandled. */
function dispatchToCallbacks(
	callbacks: Set<MessengerSubscriptionCallback> | undefined,
	payload: Record<string, any>
): void {
	if (!callbacks) return;

	for (const callback of [...callbacks]) {
		try {
			const result = callback(payload);

			if (result instanceof Promise) {
				result.catch(() => logger.warn(MESSENGER_CALLBACK_FAILED));
			}
		} catch {
			logger.warn(MESSENGER_CALLBACK_FAILED);
		}
	}
}

function buildClient(): Redis {
	const url = env['MESSENGER_REDIS'];

	const built =
		typeof url === 'string'
			? new Redis(url, FAIL_CLOSED_OPTIONS)
			: new Redis({ ...getConfigFromEnv('MESSENGER_REDIS'), ...FAIL_CLOSED_OPTIONS });

	// ioredis prints unhandled errors to stderr, so attach this before setup or cleanup can fail.
	built.on('error', () => undefined);

	return built;
}

export class MessengerMemory implements Messenger {
	handlers: Map<string, Set<MessengerSubscriptionCallback>>;

	constructor() {
		this.handlers = new Map();
	}

	publish(channel: string, payload: Record<string, any>) {
		dispatchToCallbacks(this.handlers.get(channel), payload);
	}

	subscribe(channel: string, callback: MessengerSubscriptionCallback) {
		let callbacks = this.handlers.get(channel);

		if (!callbacks) {
			callbacks = new Set();
			this.handlers.set(channel, callbacks);
		}

		callbacks.add(callback);
	}

	unsubscribe(channel: string, callback: MessengerSubscriptionCallback) {
		const callbacks = this.handlers.get(channel);
		if (!callbacks) return;

		callbacks.delete(callback);
		if (callbacks.size === 0) this.handlers.delete(channel);
	}

	getStatus(): MessengerStatus {
		return 'available';
	}
}

export class MessengerRedis implements Messenger {
	namespace: string;
	pub!: Redis;
	sub!: Redis;

	private failed = false;
	private desired = new Map<string, Set<MessengerSubscriptionCallback>>();
	private acked = new Set<string>();
	private pendingUnsub = new Set<string>();
	private subGeneration = 0;
	private pubGeneration = 0;
	private subReady = false;
	private pubReady = false;
	private pubHealthy = false;
	private status: MessengerStatus = 'unavailable';
	private sawFailure = false;
	private degraded = false;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveryAttempt = 0;
	private recovering = false;
	private destroyed = false;

	constructor() {
		this.namespace = env['MESSENGER_NAMESPACE'] ?? 'cairncms';

		let pub: Redis | undefined;
		let sub: Redis | undefined;

		try {
			pub = buildClient();
			sub = buildClient();
		} catch {
			// Construction failures cannot recover in-process. Mark the instance failed before cleanup.
			this.failed = true;
			logger.warn(MESSENGER_CONFIG_INVALID);

			for (const partial of [pub, sub]) {
				try {
					partial?.disconnect();
				} catch {
					// Cleanup cannot override fail-soft construction.
				}
			}

			return;
		}

		this.pub = pub;
		this.sub = sub;

		this.sub.on('message', (channel: string, payloadString: string) => {
			dispatchToCallbacks(this.desired.get(channel), parseJSON(payloadString));
		});

		// Raw errors stay suppressed; this listener updates health and transition state.
		this.pub.on('error', () => this.onError());
		this.sub.on('error', () => this.onError());

		this.pub.on('ready', () => this.onReady('pub'));
		this.sub.on('ready', () => this.onReady('sub'));
		this.pub.on('close', () => this.onDown('pub'));
		this.pub.on('end', () => this.onDown('pub'));
		this.sub.on('close', () => this.onDown('sub'));
		this.sub.on('end', () => this.onDown('sub'));
	}

	publish(channel: string, payload: Record<string, any>) {
		if (this.failed) return;

		const generation = this.pubGeneration;

		this.runOn('pub', this.pub.publish(`${this.namespace}:${channel}`, JSON.stringify(payload))).then(
			() => {
				if (generation === this.pubGeneration) {
					this.pubHealthy = true;
					this.updateStatus();
				}
			},
			() => {
				this.sawFailure = true;
				this.pubHealthy = false;
				this.updateStatus();
			}
		);
	}

	subscribe(channel: string, callback: MessengerSubscriptionCallback) {
		if (this.failed) return;

		const full = `${this.namespace}:${channel}`;
		let callbacks = this.desired.get(full);
		const firstForChannel = callbacks === undefined;

		if (!callbacks) {
			callbacks = new Set();
			this.desired.set(full, callbacks);
		}

		callbacks.add(callback);

		// One Redis subscription per channel: only the first callback drives the subscribe.
		if (firstForChannel) {
			this.pendingUnsub.delete(full);
			this.acked.delete(full);

			if (this.subReady) {
				const generation = this.subGeneration;

				this.runOn('sub', this.sub.subscribe(full)).then(
					() => {
						if (generation === this.subGeneration && this.desired.has(full)) {
							this.acked.add(full);
							this.updateStatus();
						}
					},
					() => {
						if (generation === this.subGeneration) {
							this.sawFailure = true;
							this.updateStatus();
						}
					}
				);
			}
		}

		this.updateStatus();
	}

	unsubscribe(channel: string, callback: MessengerSubscriptionCallback) {
		if (this.failed) return;

		const full = `${this.namespace}:${channel}`;
		const callbacks = this.desired.get(full);
		if (!callbacks) return;

		callbacks.delete(callback);

		// Keep the Redis subscription while any callback for this channel remains.
		if (callbacks.size > 0) return;

		this.desired.delete(full);
		this.acked.delete(full);

		if (this.subReady) {
			const generation = this.subGeneration;

			this.runOn('sub', this.sub.unsubscribe(full)).catch(() => {
				if (generation === this.subGeneration) {
					this.sawFailure = true;
					this.pendingUnsub.add(full);
					this.updateStatus();
				}
			});
		}

		this.updateStatus();
	}

	getStatus(): MessengerStatus {
		return this.status;
	}

	destroy(): void {
		this.destroyed = true;

		if (this.failed) return;

		this.pubGeneration++;
		this.subGeneration++;
		this.clearRecoveryTimer();
		this.pub.disconnect();
		this.sub.disconnect();
	}

	private onError(): void {
		this.sawFailure = true;
		this.updateStatus();
	}

	private onReady(kind: 'pub' | 'sub'): void {
		if (kind === 'pub') this.pubReady = true;
		else this.subReady = true;

		this.recoveryAttempt = 0;
		this.clearRecoveryTimer();
		void this.attemptRecovery();
	}

	private onDown(kind: 'pub' | 'sub'): void {
		this.sawFailure = true;

		if (kind === 'pub') {
			if (this.pubReady) {
				this.pubReady = false;
				this.pubGeneration++;
				this.pubHealthy = false;
			}
		} else if (this.subReady) {
			this.subReady = false;
			this.subGeneration++;
			this.acked.clear();
		}

		this.updateStatus();
	}

	private async attemptRecovery(): Promise<void> {
		if (this.destroyed || this.recovering) return;
		this.recovering = true;

		try {
			if (this.subReady) await this.reconcileSubscriber();
			if (this.pubReady && !this.pubHealthy) await this.probePublisher();
		} catch {
			this.sawFailure = true;
		} finally {
			this.recovering = false;
			this.updateStatus();
		}
	}

	private async reconcileSubscriber(): Promise<void> {
		for (const full of [...this.pendingUnsub]) {
			// A subscription added after this snapshot supersedes its pending removal.
			if (this.desired.has(full)) {
				this.pendingUnsub.delete(full);
				continue;
			}

			await this.runOn('sub', this.sub.unsubscribe(full));
			this.pendingUnsub.delete(full);
		}

		for (const full of this.desired.keys()) {
			if (this.acked.has(full)) continue;
			const generation = this.subGeneration;
			await this.runOn('sub', this.sub.subscribe(full));
			if (generation === this.subGeneration) this.acked.add(full);
		}
	}

	private async probePublisher(): Promise<void> {
		const generation = this.pubGeneration;
		await this.runOn('pub', this.pub.publish(`${this.namespace}:${PROBE_CHANNEL}`, ''));
		if (generation === this.pubGeneration) this.pubHealthy = true;
	}

	private runOn(kind: 'pub' | 'sub', command: Promise<unknown>): Promise<unknown> {
		const generation = kind === 'pub' ? this.pubGeneration : this.subGeneration;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				this.recycle(kind, generation);
				reject(new Error(`command timed out after ${COMMAND_DEADLINE_MS}ms`));
			}, COMMAND_DEADLINE_MS);
		});

		return Promise.race([command, deadline]).finally(() => {
			if (timer) clearTimeout(timer);
			command.catch(() => undefined);
		});
	}

	private recycle(kind: 'pub' | 'sub', generation: number): void {
		if (this.destroyed) return;

		if (kind === 'pub') {
			if (generation !== this.pubGeneration) return;
			this.sawFailure = true;
			this.pubGeneration++;
			this.pubReady = false;
			this.pubHealthy = false;
			this.pub.disconnect(true);
		} else {
			if (generation !== this.subGeneration) return;
			this.sawFailure = true;
			this.subGeneration++;
			this.subReady = false;
			this.acked.clear();
			this.sub.disconnect(true);
		}

		this.updateStatus();
	}

	private updateStatus(): void {
		if (this.destroyed) return;

		const subscriberHealthy =
			this.subReady &&
			this.pendingUnsub.size === 0 &&
			[...this.desired.keys()].every((channel) => this.acked.has(channel));

		const publisherHealthy = this.pubReady && this.pubHealthy;
		this.status = subscriberHealthy && publisherHealthy ? 'available' : 'unavailable';

		if (this.status === 'available') {
			if (this.degraded) {
				this.degraded = false;
				logger.info(MESSENGER_RECOVERED);
			}

			this.sawFailure = false;
			this.recoveryAttempt = 0;
			this.clearRecoveryTimer();
			return;
		}

		if (this.sawFailure && !this.degraded) {
			this.degraded = true;
			logger.warn(MESSENGER_UNAVAILABLE);
		}

		const subNeedsWork = this.subReady && !subscriberHealthy;
		const pubNeedsWork = this.pubReady && !publisherHealthy;

		if (subNeedsWork || pubNeedsWork) this.scheduleRecovery();
	}

	private scheduleRecovery(): void {
		if (this.recoveryTimer || this.recovering || this.destroyed) return;

		this.recoveryAttempt++;
		const delay = Math.min(this.recoveryAttempt * 50, 2_000);

		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			void this.attemptRecovery();
		}, delay);
	}

	private clearRecoveryTimer(): void {
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
	}
}

let messenger: Messenger | undefined;

export function getMessenger(): Messenger {
	if (messenger) return messenger;

	messenger = env['MESSENGER_STORE'] === 'redis' ? new MessengerRedis() : new MessengerMemory();

	return messenger;
}

export function getMessengerStatus(): MessengerStatus {
	return getMessenger().getStatus();
}

export function destroyMessenger(): void {
	if (messenger instanceof MessengerRedis) messenger.destroy();
}
