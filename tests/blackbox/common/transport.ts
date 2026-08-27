import request, { Response } from 'supertest';
import { EnumType, jsonToGraphQLQuery } from 'json-to-graphql-query';
import { WebSocket } from 'ws';
import { createClient } from 'graphql-ws';
import type {
	WebSocketOptions,
	WebSocketOptionsGql,
	WebSocketResponse,
	WebSocketSubscriptionOptions,
	WebSocketSubscriptionOptionsGql,
	WebSocketUID,
} from './types';

export function processGraphQLJson(jsonQuery: any) {
	return jsonToGraphQLQuery(jsonQuery);
}

export async function requestGraphQL(
	host: string,
	isSystemCollection: boolean,
	token: string | null,
	jsonQuery: any,
	options?: { variables?: any; cookies?: string[] }
): Promise<Response> {
	const req = request(host)
		.post(isSystemCollection ? '/graphql/system' : '/graphql')
		.send({
			query: processGraphQLJson(jsonQuery),
			variables: options?.variables,
		});

	if (token) req.set('Authorization', `Bearer ${token}`);
	if (options?.cookies) req.set('Cookie', options.cookies);

	return await req;
}

const stateName = (state: number): string => {
	switch (state) {
		case WebSocket.CONNECTING:
			return 'CONNECTING';
		case WebSocket.OPEN:
			return 'OPEN';
		case WebSocket.CLOSING:
			return 'CLOSING';
		case WebSocket.CLOSED:
			return 'CLOSED';
		default:
			return 'INVALID';
	}
};

// Strict mode authenticates during the HTTP upgrade, before connection_init.
const bearerWebSocket = (token: string) =>
	class extends WebSocket {
		constructor(address: string, protocols?: string | string[]) {
			super(address, protocols, { headers: { Authorization: `Bearer ${token}` } });
		}
	};

export function createWebSocketConn(host: string, config?: WebSocketOptions) {
	const defaults = { waitTimeout: 5000 };
	const parsedHost = host.split('//').slice(1).join('/');
	const authMode = config?.authMode ?? 'handshake';
	const token = config?.auth?.access_token;

	const clientOptions =
		authMode === 'strict' && token !== undefined
			? { ...config?.client, headers: { ...config?.client?.headers, Authorization: `Bearer ${token}` } }
			: config?.client;

	const conn = new WebSocket(
		`ws://${parsedHost}/${config?.path ?? 'websocket'}${config?.queryString ? `?${config.queryString}` : ''}`,
		clientOptions
	);

	// Handshake is ready only after its in-band authentication response.
	let connectionAuthCompleted = !(authMode === 'handshake' && token !== undefined);
	let authError: WebSocketResponse | undefined;
	const messages: Record<WebSocketUID, any[]> = {};
	const messagesDefault: WebSocketResponse[] = [];
	let readIndexDefault = 0;
	const readIndexes: Record<WebSocketUID, number> = {};

	const waitForState = (state: WebSocket['readyState'], options?: { waitTimeout?: number }) => {
		const startMs = Date.now();

		const promise = (): Promise<boolean> => {
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					if (authError !== undefined) {
						conn.terminate();
						return reject(new Error(`Authentication failed: ${JSON.stringify(authError['error'] ?? authError)}`));
					}

					if (conn.readyState === state && (conn.readyState !== conn.OPEN || connectionAuthCompleted)) {
						return resolve(true);
					} else if (Date.now() < startMs + (options?.waitTimeout ?? config?.waitTimeout ?? defaults.waitTimeout)) {
						return promise().then(resolve, reject);
					} else {
						conn.terminate();
						return reject(new Error(`WebSocket failed to achieve the ${stateName(state)} state`));
					}
				}, 5);
			});
		};

		return promise();
	};

	const getMessages = async (
		messageCount: number,
		options?: { waitTimeout?: number; targetState?: WebSocket['readyState']; uid?: WebSocketUID; startIndex?: number }
	): Promise<WebSocketResponse[] | undefined> => {
		const targetMessages =
			options?.uid !== undefined
				? messages[String(options.uid)] ?? (messages[String(options.uid)] = [])
				: messagesDefault;

		let startMessageIndex: number;

		if (options?.startIndex) {
			startMessageIndex = options.startIndex;
		} else if (options?.uid !== undefined) {
			startMessageIndex = readIndexes[String(options.uid)] ?? 0;
		} else {
			startMessageIndex = readIndexDefault;
		}

		const endMessageIndex = startMessageIndex + messageCount;

		if (options?.uid !== undefined) {
			readIndexes[String(options.uid)] = endMessageIndex;
		} else {
			readIndexDefault = endMessageIndex;
		}

		await waitForState(options?.targetState ?? WebSocket.OPEN);
		const startMs = Date.now();

		const promise = (): Promise<WebSocketResponse[] | undefined> => {
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					if (targetMessages.length >= endMessageIndex) {
						resolve(targetMessages.slice(startMessageIndex, endMessageIndex));
					} else if (Date.now() < startMs + (options?.waitTimeout ?? config?.waitTimeout ?? defaults.waitTimeout)) {
						return promise().then(resolve, reject);
					} else {
						conn.terminate();

						return reject(
							new Error(
								`Missing message${options?.uid !== undefined ? ` for "${String(options.uid)}"` : ''} (received ${
									targetMessages.length - startMessageIndex
								}/${messageCount})`
							)
						);
					}
				}, 5);
			});
		};

		return promise();
	};

	const getMessageCount = (uid?: WebSocketUID) => {
		if (uid !== undefined) return messages[String(uid)]?.length ?? 0;
		return messagesDefault.length;
	};

	const sendMessage = async (message: Record<string, any>, options?: { callback?: () => void }) => {
		await waitForState(WebSocket.OPEN);
		conn.send(JSON.stringify(message), options?.callback);
	};

	const subscribe = async (options: WebSocketSubscriptionOptions) => {
		if (options.uid !== undefined && !messages[String(options.uid)]) messages[String(options.uid)] = [];
		await sendMessage({ type: 'subscribe', ...options });
		let response;
		let error;

		try {
			response = await getMessages(1, { uid: options.uid });
		} catch (err) {
			error = err;
		}

		if (error || !response || response[0]!.status === 'error') {
			throw new Error(
				`Unable to subscribe to "${options.collection}"${options.uid !== undefined ? ` for "${options.uid}"` : ''}`
			);
		}

		return response[0];
	};

	const unsubscribe = async (uid?: WebSocketUID) => {
		await sendMessage({ type: 'unsubscribe', uid });
		let response;
		let error;

		try {
			response = await getMessages(1, { uid });
		} catch (err) {
			error = err;
		}

		if (error || !response || response[0]!.status === 'error') {
			throw new Error(`Unable to unsubscribe${uid !== undefined ? ` to "${uid}"` : ''}`);
		}
	};

	conn.on('open', () => {
		if (authMode === 'handshake' && token !== undefined) {
			conn.send(JSON.stringify({ type: 'auth', access_token: token }));
		}

		conn.on('message', (data) => {
			const message: WebSocketResponse = JSON.parse(data.toString());

			if (config?.respondToPing !== false && message.type === 'ping') {
				conn.send(JSON.stringify({ type: 'pong' }));
				return;
			}

			if (!connectionAuthCompleted && message.type === 'auth') {
				if (message.status === 'ok') {
					connectionAuthCompleted = true;
				} else {
					authError = message;
				}

				return;
			}

			const targetMessages =
				message.uid !== undefined
					? messages[String(message.uid)] ?? (messages[String(message.uid)] = [])
					: messagesDefault;

			targetMessages.push(message);
		});
	});

	conn.on('error', () => undefined);

	return { conn, waitForState, getMessages, getMessageCount, sendMessage, subscribe, unsubscribe };
}

export function createWebSocketGql(host: string, config?: WebSocketOptionsGql) {
	const defaults = { waitTimeout: 5000 };
	const parsedHost = host.split('//').slice(1).join('/');
	const authMode = config?.authMode ?? 'handshake';
	const token = config?.auth?.access_token;
	let conn: WebSocket | null = null;
	let isConnReady = false;

	const connectionParams = authMode === 'strict' || token === undefined ? undefined : { access_token: token };

	const webSocketImpl =
		authMode === 'strict' && token !== undefined ? bearerWebSocket(token) : config?.client?.webSocketImpl ?? WebSocket;

	let pendingProtocolId: string | undefined;
	let autoProtocolId = 0;
	const protocolFrames: Array<{ id?: string; type?: string }> = [];

	const client = createClient({
		// Authentication-derived options must override caller options.
		...config?.client,
		webSocketImpl,
		connectionParams,
		generateID: (payload) => pendingProtocolId ?? config?.client?.generateID?.(payload) ?? `auto-${autoProtocolId++}`,
		disablePong: !config?.respondToPing,
		url: `ws://${parsedHost}/${config?.path ?? 'graphql'}${config?.queryString ? `?${config.queryString}` : ''}`,
		on: {
			...config?.client?.on,
			closed: (...args: any[]) => {
				(config?.client?.on?.closed as any)?.(...args);
				conn = null;
			},
			opened: (socket) => {
				config?.client?.on?.opened?.(socket);
				conn = socket as WebSocket;

				conn.on('message', (data) => {
					const message: WebSocketResponse = JSON.parse(data.toString());
					protocolFrames.push({ id: message['id'], type: message.type });

					if (message.type === 'connection_ack') {
						isConnReady = true;
					}

					if (config?.respondToPing !== false && message.type === 'ping') {
						conn?.send(JSON.stringify({ type: 'pong' }));
						return;
					}
				});
			},
		},
	});

	const messages: Record<string, any[]> = {};
	const messagesDefault: any[] = [];
	let readIndexDefault = 0;
	const readIndexes: Record<WebSocketUID, number> = {};
	const unsubscriptions: Record<string, () => void> = {};
	let unsubscriptionDefault: () => void;
	const errors: Record<string, unknown> = {};
	let errorDefault: unknown;
	const completedFlags: Record<string, boolean> = {};
	let completedDefault = false;

	const waitForState = (state: WebSocket['readyState'], options?: { waitTimeout?: number }) => {
		const startMs = Date.now();

		const promise = (): Promise<boolean> => {
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					if (isConnReady && conn && conn.readyState === state) {
						return resolve(true);
					} else if (Date.now() < startMs + (options?.waitTimeout ?? config?.waitTimeout ?? defaults.waitTimeout)) {
						return promise().then(resolve, reject);
					} else {
						conn?.terminate();
						return reject(new Error(`WebSocket failed to achieve the ${stateName(state)} state`));
					}
				}, 5);
			});
		};

		return promise();
	};

	const getMessages = async (
		messageCount: number,
		options?: { waitTimeout?: number; targetState?: WebSocket['readyState']; uid?: WebSocketUID; startIndex?: number }
	): Promise<WebSocketResponse[] | undefined> => {
		const targetMessages =
			options?.uid !== undefined
				? messages[String(options.uid)] ?? (messages[String(options.uid)] = [])
				: messagesDefault;

		let startMessageIndex: number;

		if (options?.startIndex) {
			startMessageIndex = options.startIndex;
		} else if (options?.uid !== undefined) {
			startMessageIndex = readIndexes[String(options.uid)] ?? 0;
		} else {
			startMessageIndex = readIndexDefault;
		}

		const endMessageIndex = startMessageIndex + messageCount;

		if (options?.uid !== undefined) {
			readIndexes[String(options.uid)] = endMessageIndex;
		} else {
			readIndexDefault = endMessageIndex;
		}

		await waitForState(options?.targetState ?? WebSocket.OPEN);
		const startMs = Date.now();

		const promise = (): Promise<WebSocketResponse[] | undefined> => {
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					if (targetMessages.length >= endMessageIndex) {
						resolve(targetMessages.slice(startMessageIndex, endMessageIndex));
					} else if (Date.now() < startMs + (options?.waitTimeout ?? config?.waitTimeout ?? defaults.waitTimeout)) {
						return promise().then(resolve, reject);
					} else {
						conn?.terminate();

						return reject(
							new Error(
								`Missing message${options?.uid !== undefined ? ` for "${String(options.uid)}"` : ''} (received ${
									targetMessages.length - startMessageIndex
								}/${messageCount})`
							)
						);
					}
				}, 5);
			});
		};

		return promise();
	};

	const getMessageCount = (uid?: WebSocketUID) => {
		if (uid !== undefined) return messages[String(uid)]?.length ?? 0;
		return messagesDefault.length;
	};

	const getError = (uid?: WebSocketUID): unknown => (uid !== undefined ? errors[String(uid)] : errorDefault);

	const isCompleted = (uid?: WebSocketUID): boolean =>
		uid !== undefined ? completedFlags[String(uid)] ?? false : completedDefault;

	const waitForError = async (options?: { uid?: WebSocketUID; waitTimeout?: number }): Promise<unknown> => {
		const startMs = Date.now();

		const promise = (): Promise<unknown> => {
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					const err = getError(options?.uid);

					if (err !== undefined) {
						return resolve(err);
					} else if (Date.now() < startMs + (options?.waitTimeout ?? config?.waitTimeout ?? defaults.waitTimeout)) {
						return promise().then(resolve, reject);
					} else {
						return reject(
							new Error(`No error received${options?.uid !== undefined ? ` for "${String(options.uid)}"` : ''}`)
						);
					}
				}, 5);
			});
		};

		return promise();
	};

	const subscribe = async (options: WebSocketSubscriptionOptionsGql) => {
		const targetMessages =
			options.uid !== undefined
				? messages[String(options.uid)] ?? (messages[String(options.uid)] = [])
				: messagesDefault;

		const subscriptionKey = `${options.collection}_mutated`;
		const args = options.event ? { __args: { event: new EnumType(options.event) } } : false;
		const query = processGraphQLJson({ subscription: { [subscriptionKey]: { ...args, ...options.jsonQuery } } });

		let unsubscribe: () => void;

		// generateID reads this synchronously; always clear it if setup throws.
		pendingProtocolId = options.protocolId;

		try {
			unsubscribe = client.subscribe(
				{ query },
				{
					next: (data: any) => {
						targetMessages.push(data);
					},
					error: (err: unknown) => {
						if (options.uid !== undefined) {
							errors[String(options.uid)] = err;
						} else {
							errorDefault = err;
						}
					},
					complete: () => {
						if (options.uid !== undefined) {
							completedFlags[String(options.uid)] = true;
						} else {
							completedDefault = true;
						}
					},
				}
			);
		} finally {
			pendingProtocolId = undefined;
		}

		if (options.uid !== undefined) {
			unsubscriptions[String(options.uid)] = unsubscribe;
		} else {
			unsubscriptionDefault = unsubscribe;
		}

		await waitForState(WebSocket.OPEN);
		return subscriptionKey;
	};

	const unsubscribe = (uid?: WebSocketUID) => {
		if (uid !== undefined) {
			unsubscriptions[String(uid)]?.();
		} else if (unsubscriptionDefault) {
			unsubscriptionDefault();
		}
	};

	// Bypass graphql-ws so tests can observe frames after server-side completion.
	const sendRaw = async (message: Record<string, any>): Promise<void> => {
		await waitForState(WebSocket.OPEN);
		conn!.send(JSON.stringify(message));
	};

	const waitForFrame = (
		match: (frame: { id?: string; type?: string }) => boolean,
		options?: { waitTimeout?: number }
	): Promise<void> => {
		const startMs = Date.now();

		const promise = (): Promise<void> => {
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					if (protocolFrames.some(match)) {
						return resolve();
					} else if (Date.now() < startMs + (options?.waitTimeout ?? config?.waitTimeout ?? defaults.waitTimeout)) {
						return promise().then(resolve, reject);
					} else {
						return reject(new Error('Expected protocol frame not received'));
					}
				}, 5);
			});
		};

		return promise();
	};

	return {
		client,
		getMessages,
		getMessageCount,
		getError,
		isCompleted,
		waitForError,
		getProtocolFrames: () => protocolFrames,
		sendRaw,
		waitForFrame,
		subscribe,
		unsubscribe,
		waitForState,
	};
}
