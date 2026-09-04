import type { ActionHandler, EventContext, FilterHandler, InitHandler } from '@cairncms/types';
import ee2 from 'eventemitter2';
import logger from './logger.js';
import { safeLogFragment } from './utils/safe-log-fragment.js';

export class Emitter {
	private filterEmitter;
	private actionEmitter;
	private initEmitter;

	constructor() {
		const emitterOptions = {
			wildcard: true,
			verboseMemoryLeak: true,
			delimiter: '.',

			// This will ignore the "unspecified event" error
			ignoreErrors: true,
		};

		this.filterEmitter = new ee2.EventEmitter2(emitterOptions);
		this.actionEmitter = new ee2.EventEmitter2(emitterOptions);
		this.initEmitter = new ee2.EventEmitter2(emitterOptions);
	}

	public async emitFilter<T>(
		event: string | string[],
		payload: T,
		meta: Record<string, any>,
		context: EventContext
	): Promise<T> {
		const events = Array.isArray(event) ? event : [event];

		const eventListeners = events.map((event) => ({
			event,
			listeners: this.filterEmitter.listeners(event) as FilterHandler<T>[],
		}));

		let updatedPayload = payload;

		for (const { event, listeners } of eventListeners) {
			for (const listener of listeners) {
				const result = await listener(updatedPayload, { event, ...meta }, context);

				if (result !== undefined) {
					updatedPayload = result;
				}
			}
		}

		return updatedPayload;
	}

	public emitAction(event: string | string[], meta: Record<string, any>, context: EventContext): void {
		void this.dispatchActions(event, meta, context);
	}

	public async emitActionAndWait(
		event: string | string[],
		meta: Record<string, any>,
		context: EventContext
	): Promise<void> {
		await this.dispatchActions(event, meta, context);
	}

	private async dispatchActions(
		event: string | string[],
		meta: Record<string, any>,
		context: EventContext
	): Promise<void> {
		const events = Array.isArray(event) ? event : [event];
		const pending: Promise<unknown>[] = [];

		// Start every listener before awaiting, and handle each returned promise before invoking the next.
		for (const event of events) {
			for (const listener of this.actionEmitter.listeners(event) as ActionHandler[]) {
				// EventEmitter2 restores the current event before each invocation, in case a listener emits.
				(this.actionEmitter as unknown as { event: string }).event = event;

				try {
					const result = listener.call(this.actionEmitter, { event, ...meta }, context) as unknown;

					if (result && typeof (result as { then?: unknown }).then === 'function') {
						pending.push(
							Promise.resolve(result as PromiseLike<unknown>).catch(() => this.logActionHandlerError(event))
						);
					}
				} catch {
					this.logActionHandlerError(event);
				}
			}
		}

		await Promise.allSettled(pending);
	}

	private logActionHandlerError(event: string): void {
		logger.warn(`An error was thrown while executing action "${safeLogFragment(event)}"`);
	}

	public async emitActionBounded(event: string, meta: Record<string, any>, context: EventContext): Promise<void> {
		const listeners = this.actionEmitter.listeners(event) as ActionHandler[];
		const payload = { event, ...meta };

		const pending = listeners.map((listener) => {
			try {
				return Promise.resolve(listener(payload, context));
			} catch (error) {
				return Promise.reject(error);
			}
		});

		const results = await Promise.allSettled(pending);

		if (results.some((result) => result.status === 'rejected')) {
			logger.warn('An action listener threw and was contained');
		}
	}

	public async emitInit(event: string, meta: Record<string, any>): Promise<void> {
		try {
			await this.initEmitter.emitAsync(event, { event, ...meta });
		} catch (err: any) {
			logger.warn(`An error was thrown while executing init "${event}"`);
			logger.warn(err);
		}
	}

	public onFilter(event: string, handler: FilterHandler): void {
		this.filterEmitter.on(event, handler);
	}

	public onAction(event: string, handler: ActionHandler): void {
		this.actionEmitter.on(event, handler);
	}

	public onInit(event: string, handler: InitHandler): void {
		this.initEmitter.on(event, handler);
	}

	public offFilter(event: string, handler: FilterHandler): void {
		this.filterEmitter.off(event, handler);
	}

	public offAction(event: string, handler: ActionHandler): void {
		this.actionEmitter.off(event, handler);
	}

	public offInit(event: string, handler: InitHandler): void {
		this.initEmitter.off(event, handler);
	}

	public offAll(): void {
		this.filterEmitter.removeAllListeners();
		this.actionEmitter.removeAllListeners();
		this.initEmitter.removeAllListeners();
	}
}

const emitter = new Emitter();

export default emitter;
