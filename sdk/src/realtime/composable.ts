import type { AuthenticationClient } from '../auth/types.js';
import type { ConsoleInterface, WebSocketInterface } from '../index.js';
import type { CairnCMSClient } from '../types/client.js';
import { queryToParams, type ExtendedQuery } from '../rest/utils/query-to-params.js';
import { auth } from './commands/auth.js';
import type {
	ConnectionState,
	ReconnectState,
	SubscribeOptions,
	SubscriptionEvents,
	SubscriptionOutput,
	WebSocketAuthError,
	WebSocketClient,
	WebSocketConfig,
	WebSocketEventHandler,
	WebSocketEvents,
} from './types.js';
import { ChannelRegistry } from './utils/channel-registry.js';

type AuthWSClient<Schema> = WebSocketClient<Schema> & AuthenticationClient<Schema>;

const defaultRealTimeConfig: WebSocketConfig = {
	authMode: 'handshake',
	debug: false,
	connect: {
		timeout: 10000, // 10 seconds
	},
	reconnect: false,
};

// The largest delay a browser/Node timer represents without overflowing back to a near-zero interval.
const MAX_TIMER_DELAY = 2_147_483_647;

// The reconnect backoff is jittered up to twice the base, so bound the requested delay to half the timer ceiling.
const MAX_RECONNECT_DELAY = Math.floor(MAX_TIMER_DELAY / 2);

/**
 * Creates a client to communicate with a CairnCMS REST WebSocket.
 *
 * @param config The optional configuration.
 *
 * @returns A CairnCMS realtime client.
 */
export function realtime(userConfig: WebSocketConfig = {}) {
	return <Schema>(client: CairnCMSClient<Schema>) => {
		// A per-client resolved config with cloned nested objects, so later mutation of the supplied config cannot
		// change an existing client or bypass the one-time validation below.
		const config = { ...defaultRealTimeConfig, ...userConfig };
		if (config.reconnect) config.reconnect = { ...config.reconnect };
		if (config.connect) config.connect = { ...config.connect };

		if (config.authMode !== 'public' && config.authMode !== 'handshake') {
			throw new Error(`Invalid authMode configuration: expected "public" or "handshake".`);
		}

		if (config.reconnect) {
			const { retries, delay } = config.reconnect;

			if (
				!Number.isSafeInteger(retries) ||
				retries < 0 ||
				!Number.isFinite(delay) ||
				delay < 0 ||
				delay > MAX_RECONNECT_DELAY
			) {
				throw new Error(
					`Invalid reconnect configuration: "retries" must be a non-negative safe integer and "delay" a non-negative finite number of milliseconds no greater than ${MAX_RECONNECT_DELAY}.`
				);
			}
		}

		if (
			config.connect &&
			(!Number.isFinite(config.connect.timeout) ||
				config.connect.timeout < 0 ||
				config.connect.timeout > MAX_TIMER_DELAY)
		) {
			throw new Error(
				`Invalid connect configuration: "timeout" must be a non-negative finite number of milliseconds no greater than ${MAX_TIMER_DELAY}.`
			);
		}

		let state: ConnectionState = {
			code: 'closed',
		};

		const reconnectState: ReconnectState = {
			active: false,
		};

		let wasManuallyDisconnected = false;

		// The teardown of the connection attempt currently in setup, so a manual disconnect can cancel it.
		let pendingConnect: { teardown: (reason: unknown) => void; promise: Promise<WebSocketInterface> } | null = null;

		// Late events may mutate state only for the current connection attempt.
		let currentAttempt: object | null = null;

		// Cancels a pending reconnect backoff so a manual disconnect stops recovery without waiting out the delay.
		const noReconnectDelay = () => {
			/* no backoff is currently pending */
		};

		let cancelReconnectDelay: () => void = noReconnectDelay;

		// Active subscriptions keyed by their canonical uid so replay and targeting stay unique across a reconnect.
		const subscriptions = new Map<string, Record<string, any>>();

		let receiveBufferFailed = false;

		// Initial authentication does not consume the TOKEN_EXPIRED retry budget.
		let lastRetriedToken: string | null = null;
		let warnedSameToken = false;
		let refreshingSocket: WebSocketInterface | null = null;

		const onOverflow = (error: Error) => {
			receiveBufferFailed = true;
			lastRetriedToken = null;
			warnedSameToken = false;
			subscriptions.clear();
			debug('warn', error.message);

			if (state.code === 'open') {
				try {
					state.connection.close();
				} catch {
					/* the socket may already be closing */
				}
			}
		};

		const registry = new ChannelRegistry(onOverflow);

		let resolveAuthAck: ((message: Record<string, any>) => void) | null = null;

		const finalizeSubscriptions = (settle: () => void) => {
			lastRetriedToken = null;
			warnedSameToken = false;
			settle();
			subscriptions.clear();
		};

		const hasAuth = (client: AuthWSClient<Schema>) => 'getToken' in client;

		const debug = (level: keyof ConsoleInterface, ...data: any[]) => {
			if (!config.debug) return;

			// Diagnostics must never disrupt the connection lifecycle, so an injected logger that throws or rejects
			// is contained here rather than propagating into a callback-isolation or teardown path.
			try {
				const result = client.globals.logger[level]('[CairnCMS SDK]', ...data) as unknown;

				if (result && typeof (result as { then?: unknown }).then === 'function') {
					(result as Promise<unknown>).catch(() => undefined);
				}
			} catch {
				/* swallow logger failures */
			}
		};

		const getSocketUrl = () => {
			if ('url' in config && config.url) return new client.globals.URL(config.url).toString();

			// if the main URL is a websocket URL use it directly!
			if (['ws:', 'wss:'].includes(client.url.protocol)) return client.url.toString();

			// try filling in the defaults based on the main URL
			const newUrl = new client.globals.URL(client.url.toString());
			newUrl.protocol = client.url.protocol === 'https:' ? 'wss:' : 'ws:';
			newUrl.pathname = '/websocket';

			return newUrl.toString();
		};

		/**
		 * Recovery of a dropped connection is opt-in and owned by the consumer. When enabled it runs a single bounded
		 * loop with a jittered backoff so independent clients do not retry in lockstep, re-establishes the socket, and
		 * replays every active subscription. Any attempt failure, including a rejected authentication, counts against
		 * the retry budget so the loop always terminates.
		 */
		// A backoff a manual disconnect can cut short, so recovery stops promptly instead of waiting out the delay.
		const reconnectDelay = (ms: number) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					cancelReconnectDelay = noReconnectDelay;
					resolve();
				}, ms);

				cancelReconnectDelay = () => {
					clearTimeout(timer);
					cancelReconnectDelay = noReconnectDelay;
					resolve();
				};
			});

		const reconnect = (self: WebSocketClient<Schema>) => {
			if (!config.reconnect || wasManuallyDisconnected || reconnectState.active) return;

			const { retries, delay } = config.reconnect;
			const floor = Math.max(100, delay);

			const run = (async () => {
				const replayTargets = Array.from(subscriptions.entries());

				for (let attempt = 1; attempt <= retries; attempt++) {
					// check cancellation before scheduling each attempt, so a disconnect ends recovery promptly
					if (wasManuallyDisconnected) return;

					await reconnectDelay(floor + Math.floor(Math.random() * floor));

					if (wasManuallyDisconnected) return;

					try {
						await self.connect();
					} catch {
						debug('warn', `Reconnect attempt ${attempt} of ${retries} failed.`);
						continue;
					}

					try {
						for (const [uid, sub] of replayTargets) {
							if (subscriptions.get(uid) === sub) self.sendMessage(sub);
						}

						return;
					} catch (error) {
						debug('warn', 'Replay after reconnect failed; aborting recovery.', error);

						finalizeSubscriptions(() =>
							registry.failAll(new Error('Realtime subscription replay failed after reconnect.'))
						);

						if (state.code === 'open') {
							try {
								state.connection.close();
							} catch {
								/* the socket may already be closing */
							}
						}

						return;
					}
				}

				debug('warn', 'Reconnect retries exhausted.');
				finalizeSubscriptions(() => registry.failAll(new Error('Realtime reconnect attempts were exhausted.')));
			})();

			reconnectState.active = run.finally(() => {
				reconnectState.active = false;
			});
		};

		const eventHandlers: Record<WebSocketEvents, Set<WebSocketEventHandler>> = {
			open: new Set<WebSocketEventHandler>([]),
			error: new Set<WebSocketEventHandler>([]),
			close: new Set<WebSocketEventHandler>([]),
			message: new Set<WebSocketEventHandler>([]),
		};

		// Consumer callbacks are isolated from internal transitions and from each other: a throwing or rejecting
		// handler is logged, never propagated, so it cannot hang connect(), block cleanup, or stop the message pump.
		const dispatchEvent = (
			handlers: Set<WebSocketEventHandler>,
			thisArg: WebSocketInterface,
			event: Event | CloseEvent | Record<string, any>
		) => {
			handlers.forEach((handler) => {
				try {
					const result = handler.call(thisArg, event);

					if (result && typeof (result as { then?: unknown }).then === 'function') {
						(result as Promise<unknown>).catch((error) => debug('warn', 'A websocket event handler rejected.', error));
					}
				} catch (error) {
					debug('warn', 'A websocket event handler threw.', error);
				}
			});
		};

		function isAuthError(message: Record<string, any> | MessageEvent<string>): message is WebSocketAuthError {
			return (
				'type' in message &&
				'status' in message &&
				'error' in message &&
				typeof message['error'] === 'object' &&
				message['error'] !== null &&
				'code' in message['error'] &&
				'message' in message['error'] &&
				message['type'] === 'auth' &&
				message['status'] === 'error'
			);
		}

		async function handleAuthError(message: WebSocketAuthError, currentClient: AuthWSClient<Schema>) {
			if (state.code !== 'open') return;

			// Re-authentication may finish after this socket has been replaced.
			const socket = state.connection;

			if (message.error.code === 'TOKEN_EXPIRED') {
				debug('warn', 'Authentication token expired!');

				if (hasAuth(currentClient) && refreshingSocket !== socket) {
					refreshingSocket = socket;

					try {
						const access_token = await currentClient.getToken();

						if (!access_token) {
							throw Error('No token for re-authenticating the websocket');
						}

						if (access_token === lastRetriedToken) {
							if (!warnedSameToken) {
								debug('warn', 'The refreshed token matches the expired one, keeping the current identity.');
								warnedSameToken = true;
							}

							return;
						}

						if (state.code === 'open' && state.connection === socket) {
							socket.send(auth({ access_token }));
							lastRetriedToken = access_token;
							warnedSameToken = false;
						}
					} finally {
						if (refreshingSocket === socket) refreshingSocket = null;
					}
				}
			}

			if (message.error.code === 'AUTH_FAILED') {
				if (state.firstMessage && config.authMode === 'public') {
					// detected likely misconfigured authMode
					debug('warn', 'Authentication failed! Currently the "authMode" is "public" try using "handshake" instead');
					config.reconnect = false;
					return state.connection.close();
				}

				debug('warn', 'Authentication failed!');
			}
		}

		/**
		 * One continuously attached ingress router per open socket. Parses each frame once and routes it to the
		 * auth waiter, the auth-error handler, the owning uid channel, and the generic message callbacks.
		 */
		const routeMessage = (self: AuthWSClient<Schema>, socket: WebSocketInterface, event: MessageEvent<any>) => {
			try {
				if (state.code !== 'open' || state.connection !== socket) return;

				const data = event.data;

				if (typeof data !== 'string') {
					dispatchEvent(eventHandlers['message'], socket, event);
					return;
				}

				const bytes = new TextEncoder().encode(data).byteLength;

				let message: Record<string, any>;

				try {
					message = JSON.parse(data);
				} catch {
					dispatchEvent(eventHandlers['message'], socket, event);
					return;
				}

				if (message === null || typeof message !== 'object' || Array.isArray(message)) {
					dispatchEvent(eventHandlers['message'], socket, message);
					return;
				}

				if (message['type'] === 'auth' && (message['status'] === 'ok' || message['status'] === 'error')) {
					if (resolveAuthAck !== null) {
						const resolve = resolveAuthAck;
						resolveAuthAck = null;
						resolve(message);
					} else if (isAuthError(message)) {
						void handleAuthError(message, self).catch((error) =>
							debug('warn', 'Failed to handle an authentication error.', error)
						);
					}
				} else if (
					'uid' in message &&
					(message['type'] === 'subscription' || (message['type'] === 'subscribe' && message['status'] === 'error'))
				) {
					const subscriptionUid = String(message['uid']);

					if (message['type'] === 'subscribe') {
						registry.fail(subscriptionUid, message);
						subscriptions.delete(subscriptionUid);
					} else {
						registry.route(subscriptionUid, message, bytes);
					}
				}

				dispatchEvent(eventHandlers['message'], socket, message);
				state.firstMessage = false;
			} catch (error) {
				debug('warn', 'Failed to route a websocket message.', error);
			}
		};

		return {
			/**
			 * Checks if a websocket connection has been established.
			 * Does not check authentication status.
			 */
			async isConnected() {
				if (state.code === 'connecting') {
					try {
						await state.connection;
					} catch {
						return false;
					}
				}

				return state.code === 'open';
			},
			async connect() {
				wasManuallyDisconnected = false;

				// Join the in-flight attempt, including the handshake window where the state already reads "open".
				if (pendingConnect) return pendingConnect.promise;

				if (state.code === 'open') return state.connection;

				if (state.code !== 'closed') {
					throw new Error(`Cannot connect when state is "${state.code}"`);
				}

				// Supersede late events even when socket construction fails.
				const attempt = {};
				currentAttempt = attempt;

				// Use the composed client so overridden authentication methods remain available.
				const self = this as AuthWSClient<Schema>;
				let ws: WebSocketInterface;

				try {
					const url = getSocketUrl();
					debug('info', `Connecting to ${url}...`);

					ws = new client.globals.WebSocket(url);
				} catch (error) {
					return Promise.reject(error);
				}

				// Eventually update to Promise.withResolvers()
				let resolve!: (value: WebSocketInterface | PromiseLike<WebSocketInterface>) => void;
				let reject!: (reason?: any) => void;

				const connectPromise = new Promise<WebSocketInterface>((res, rej) => {
					resolve = res;
					reject = rej;
				});

				state = {
					code: 'connecting',
					connection: connectPromise,
				};

				// `settled` marks the connect attempt as resolved or torn down, so a late event is ignored.
				let settled = false;
				// `established` records a fully settled setup (post-ack in handshake mode), which gates reconnection.
				let established = false;
				let connectTimeout: ReturnType<typeof setTimeout> | undefined;
				let detachRouter: (() => void) | null = null;

				const settleAuthAck = () => {
					if (resolveAuthAck === null) return;
					const resolveAck = resolveAuthAck;
					resolveAuthAck = null;
					resolveAck({});
				};

				const removeConnectListeners = () => {
					ws.removeEventListener('open', onOpen);
					ws.removeEventListener('error', onError);
					ws.removeEventListener('close', onClose);
				};

				// One shared teardown for a connect timeout, a manual disconnect during setup, and any authentication or
				// setup failure: close the transport, clear the timer, drop the listeners, ignore any late event, and
				// return to a retryable closed state.
				const teardown = (reason: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(connectTimeout);
					removeConnectListeners();
					detachRouter?.();
					settleAuthAck();
					pendingConnect = null;

					try {
						ws.close();
					} catch {
						/* the socket may already be closing */
					}

					state = { code: 'closed' };
					reject(reason);
				};

				const onOpen = async (evt: Event) => {
					if (settled) return;
					debug('info', `Connection open.`);

					receiveBufferFailed = false;
					state = { code: 'open', connection: ws, firstMessage: true };

					const onMessage = (event: MessageEvent<any>) => routeMessage(self, ws, event);
					ws.addEventListener('message', onMessage);
					detachRouter = () => ws.removeEventListener('message', onMessage);

					if (config.authMode === 'handshake') {
						if (!hasAuth(self)) {
							return teardown(
								'Handshake authentication requires an authentication composable that can supply a token.'
							);
						}

						let access_token: string | null;

						try {
							access_token = await self.getToken();
						} catch (error) {
							return teardown(error);
						}

						// a manual disconnect or timeout during getToken tears the attempt down; leave the socket alone
						if (settled) return;

						if (!access_token) {
							return teardown(
								'No token for authenticating the websocket. Make sure to provide one or call the login() function beforehand.'
							);
						}

						// Install the ack waiter before sending so a synchronous auth response already has an owner. The
						// connect deadline stays armed across the send and this await, so the ack has no separate cutoff.
						const ack = new Promise<Record<string, any>>((resolveAck) => {
							resolveAuthAck = resolveAck;
						});

						try {
							ws.send(auth({ access_token }));
						} catch (error) {
							settleAuthAck();
							return teardown(error);
						}

						const confirm = await ack;

						if (settled) return;

						if (!(confirm['type'] === 'auth' && confirm['status'] === 'ok')) {
							return teardown('Authentication failed while opening the websocket connection.');
						}

						debug('info', 'Authentication successful!');
					}

					if (settled) return;
					settled = true;
					established = true;
					clearTimeout(connectTimeout);
					pendingConnect = null;
					dispatchEvent(eventHandlers['open'], ws, evt);
					resolve(ws);
				};

				const onError = (evt: Event) => {
					debug('warn', `Connection errored.`);
					dispatchEvent(eventHandlers['error'], ws, evt);

					try {
						ws.close();
					} catch {
						/* the close listener resets the state and rejects a pending connect */
					}
				};

				const onClose = (evt: CloseEvent) => {
					// A superseded socket may clean up only its own listeners.
					if (currentAttempt !== attempt) {
						removeConnectListeners();
						detachRouter?.();
						return;
					}

					debug('info', `Connection closed.`);
					dispatchEvent(eventHandlers['close'], ws, evt);
					clearTimeout(connectTimeout);
					removeConnectListeners();
					detachRouter?.();
					settleAuthAck();
					pendingConnect = null;

					const wasSettled = settled;
					settled = true;
					state = { code: 'closed' };
					if (!wasSettled) reject(evt);

					// Recovery retains channels until replay succeeds or the reconnect loop terminates.
					if (established && !wasManuallyDisconnected && !receiveBufferFailed && config.reconnect) {
						reconnect(self);
					} else if (wasManuallyDisconnected || !reconnectState.active) {
						finalizeSubscriptions(
							wasManuallyDisconnected
								? () => registry.closeAll()
								: () => registry.failAll(new Error('The realtime connection closed.'))
						);
					}
				};

				pendingConnect = { teardown, promise: connectPromise };

				if (config.connect) {
					connectTimeout = setTimeout(() => {
						teardown('Connection attempt timed out.');
					}, config.connect.timeout ?? 10000);
				}

				ws.addEventListener('open', onOpen);
				ws.addEventListener('error', onError);
				ws.addEventListener('close', onClose);

				return connectPromise;
			},
			disconnect() {
				wasManuallyDisconnected = true;
				cancelReconnectDelay();
				lastRetriedToken = null;
				warnedSameToken = false;

				// Prioritize an in-progress attempt: during the handshake the state is already open, so a plain close
				// would race the pending setup instead of tearing it down.
				if (pendingConnect) {
					pendingConnect.teardown('Disconnected during connection setup.');
				} else if (state.code === 'open') {
					state.connection.close();
					// A fresh connect must not reuse a socket already closing asynchronously.
					state = { code: 'closed' };
				}

				// Settle subscriptions before a late close can be superseded by a new attempt.
				registry.closeAll();
				subscriptions.clear();
			},
			onWebSocket(event: WebSocketEvents, callback: (this: WebSocketInterface, ev: Event | CloseEvent | any) => any) {
				// The router hands message callbacks the already-parsed frame, so there is no second parse here.
				eventHandlers[event].add(callback);
				return () => eventHandlers[event].delete(callback);
			},
			sendMessage(message: string | Record<string, any>) {
				if (state.code !== 'open') {
					throw new Error(
						'Cannot send messages without an open connection. Make sure you are calling "await client.connect()".'
					);
				}

				if (typeof message === 'string') {
					return state.connection.send(message);
				}

				const outgoing = 'uid' in message ? message : { ...message, uid: registry.allocateUid() };
				state.connection.send(JSON.stringify(outgoing));
			},
			async subscribe<Collection extends keyof Schema, const Options extends SubscribeOptions<Schema, Collection>>(
				collection: Collection,
				options = {} as Options
			) {
				const self = this as AuthWSClient<Schema>;
				const cloned = { ...(options as Record<string, any>) };

				let subscriptionUid: string;

				if (!('uid' in cloned) || cloned['uid'] === undefined) {
					subscriptionUid = registry.allocateUid();
				} else if (typeof cloned['uid'] !== 'string') {
					throw new Error('A subscription uid must be a string.');
				} else {
					subscriptionUid = cloned['uid'];
				}

				cloned['uid'] = subscriptionUid;

				if (subscriptions.has(subscriptionUid) || registry.has(subscriptionUid)) {
					throw new Error(`A subscription with uid "${subscriptionUid}" already exists.`);
				}

				if (cloned['query']) {
					cloned['query'] = queryToParams(cloned['query'] as ExtendedQuery<Schema, Schema[Collection]>);
				}

				const subscription = { ...cloned, collection, type: 'subscribe' };

				const channel = registry.create(subscriptionUid);
				subscriptions.set(subscriptionUid, subscription);

				try {
					if (state.code !== 'open') {
						debug('info', 'No connection available for subscribing!');
						await self.connect();
					}

					self.sendMessage(subscription);
				} catch (error) {
					registry.delete(subscriptionUid, channel);
					if (subscriptions.get(subscriptionUid) === subscription) subscriptions.delete(subscriptionUid);
					throw error;
				}

				let finalized = false;

				const finalize = (settle: () => void, notifyServer: boolean) => {
					if (finalized) return;
					finalized = true;
					settle();
					registry.delete(subscriptionUid, channel);
					const wasRegistered = subscriptions.get(subscriptionUid) === subscription;
					if (wasRegistered) subscriptions.delete(subscriptionUid);

					if (notifyServer && wasRegistered && state.code === 'open') {
						try {
							self.sendMessage({ uid: subscriptionUid, type: 'unsubscribe' });
						} catch {
							/* the socket may already be closing */
						}
					}
				};

				type Output = SubscriptionOutput<Schema, Collection, Options['query'], SubscriptionEvents>;

				const iterator: AsyncGenerator<Output, void, unknown> = {
					[Symbol.asyncIterator]() {
						return this;
					},
					next: () => channel.next() as Promise<IteratorResult<Output, void>>,
					return: async () => {
						finalize(() => channel.close(), true);
						return { value: undefined, done: true };
					},
					throw: async (error?: unknown) => {
						finalize(() => channel.fail(error), true);
						return Promise.reject(error);
					},
				};

				const unsubscribe = () => finalize(() => channel.close(), true);

				return {
					subscription: iterator,
					unsubscribe,
				};
			},
		} as WebSocketClient<Schema>;
	};
}
