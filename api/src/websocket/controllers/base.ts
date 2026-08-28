import type { SchemaOverview } from '@cairncms/types';
import { parseJSON } from '@cairncms/utils';
import type { Application } from 'express';
import type { Knex } from 'knex';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { v4 as uuid } from 'uuid';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import emitter from '../../emitter.js';
import logger from '../../logger.js';
import type { RateLimitConsumption } from '../../middleware/rate-limiter-ip.js';
import type { RequestAccountability, RequestContext } from '../../utils/get-anonymous-accountability.js';
import { getIPForRequest } from '../../utils/get-ip-from-req.js';
import type { Admission, Lease, WorkHold } from '../admission.js';
import { ConnectionAuth, type AuthReject, type AuthResult } from '../authenticate.js';
import type { SubscriptionRegistry } from '../subscriptions.js';
import {
	OUTBOUND_FRAME_CAP,
	OUTBOUND_QUEUE_BYTES,
	PENDING_COMMAND_LIMIT,
	TIMER_MAX_MS,
	type AuthMode,
} from '../config.js';
import { toWebSocketException, WebSocketException, type WebSocketErrorCode } from '../exceptions.js';
import { startHeartbeat } from '../handlers/heartbeat.js';
import { WebSocketAuthMessage, WebSocketMessage } from '../messages.js';
import { fmtMessage, getMessageType, safeSend, type OutboundLimits } from '../utils/message.js';

const LOG_UPGRADE_FAILED = 'WebSocket upgrade failed';
const LOG_EXPIRY_NOTICE_FAILED = 'WebSocket expiry notice failed';

const CLOSE_TRY_AGAIN_LATER = 1013;

const DISCONNECT_EVENTS = ['close', 'error', 'end'] as const;

const OUTBOUND_LIMITS: OutboundLimits = { frameCap: OUTBOUND_FRAME_CAP, queueByteBound: OUTBOUND_QUEUE_BYTES };

export type CommandContext = {
	schema: SchemaOverview;
	accountability: RequestAccountability;
};

export type CommandHandler = (
	client: SocketClient,
	message: WebSocketMessage,
	context: CommandContext
) => Promise<void>;

interface ConnectionState {
	readonly ip: string;
	readonly origin: AuthMode;
	readonly waiting: Buffer[];
	retainedBytes: number;
	draining: boolean;
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

const REASON: Record<number, string> = {
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	429: 'Too Many Requests',
	503: 'Service Unavailable',
};

export interface SocketControllerOptions {
	transport: string;
	path: string;
	authMode: AuthMode;
	authTimeoutMs: number;
	maxPayload: number;
	heartbeatPeriodMs: number;
	admission: Admission;
	isOriginAllowed: (app: Application, req: IncomingMessage) => boolean;
	consumeIpRateLimit: (ip: string) => Promise<RateLimitConsumption>;
	consumeGlobalRateLimit: () => Promise<RateLimitConsumption>;
	app: Application;
	database: Knex;
	getSchema: (options?: { database?: Knex }) => Promise<SchemaOverview>;
	subscriptions: SubscriptionRegistry;
}

export type SocketClient = WebSocket & {
	uid: string;
	auth: ConnectionAuth;
	schema: SchemaOverview | null;
	onExpiry: () => void;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	handshakeTimer: ReturnType<typeof setTimeout> | null;
	lifecycleStarted: boolean;
	stopping: boolean;
	finalized: boolean;
	finalizationHold: WorkHold | null;
	heartbeatStop: (() => void) | null;
};

type StrictOutcome =
	| { kind: 'result'; status: 'authenticated' | 'capacity' | 'rejected' }
	| { kind: 'timeout' }
	| { kind: 'disconnect' }
	| { kind: 'error' };

export type AuthOutcome =
	| { status: 'authenticated' }
	| { status: 'ignored' }
	| { status: 'timeout' }
	| { status: 'capacity' }
	| { status: 'rejected'; reason: AuthReject };

type AuthFailureOutcome = Exclude<AuthOutcome, { status: 'authenticated' } | { status: 'ignored' }>;

export abstract class SocketController {
	protected readonly server: WebSocketServer;
	protected readonly clients: Set<SocketClient> = new Set();
	protected readonly handlers = new Map<string, CommandHandler>();
	private readonly connectionState = new WeakMap<SocketClient, ConnectionState>();

	private closing = false;
	private readonly inflightUpgrades = new Set<Promise<void>>();
	private readonly inflightDrains = new Set<Promise<void>>();
	private readonly inflightAuth = new Set<Promise<unknown>>();

	protected readonly transport: string;
	protected readonly path: string;
	protected readonly authMode: AuthMode;
	protected readonly authTimeoutMs: number;
	protected readonly heartbeatPeriodMs: number;

	protected readonly admission: Admission;
	protected readonly isOriginAllowed: (app: Application, req: IncomingMessage) => boolean;
	protected readonly consumeIpRateLimit: (ip: string) => Promise<RateLimitConsumption>;
	protected readonly consumeGlobalRateLimit: () => Promise<RateLimitConsumption>;
	protected readonly app: Application;
	protected readonly database: Knex;
	protected readonly getSchema: (options?: { database?: Knex }) => Promise<SchemaOverview>;
	protected readonly subscriptions: SubscriptionRegistry;

	constructor(options: SocketControllerOptions) {
		this.transport = options.transport;
		this.path = options.path;
		this.authMode = options.authMode;
		this.authTimeoutMs = options.authTimeoutMs;
		this.heartbeatPeriodMs = options.heartbeatPeriodMs;
		this.admission = options.admission;
		this.isOriginAllowed = options.isOriginAllowed;
		this.consumeIpRateLimit = options.consumeIpRateLimit;
		this.consumeGlobalRateLimit = options.consumeGlobalRateLimit;
		this.app = options.app;
		this.database = options.database;
		this.getSchema = options.getSchema;
		this.subscriptions = options.subscriptions;
		const subprotocol = this.acceptedSubprotocol();

		this.server = new WebSocketServer({
			noServer: true,
			maxPayload: options.maxPayload,
			...(subprotocol !== undefined && {
				handleProtocols: (protocols: Set<string>) => (protocols.has(subprotocol) ? subprotocol : false),
			}),
		});
	}

	protected acceptedSubprotocol(): string | undefined {
		return undefined;
	}

	handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
		if (!this.matchesPath(req)) return;
		if (this.closing) return this.reject(socket, 503);

		const upgrade = this.runUpgrade(req, socket, head);
		this.inflightUpgrades.add(upgrade);

		try {
			await upgrade;
		} finally {
			this.inflightUpgrades.delete(upgrade);
		}
	};

	ownsUpgrade(req: IncomingMessage): boolean {
		return this.matchesPath(req);
	}

	private async runUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		let auth: ConnectionAuth | null = null;
		let lease: Lease | null = null;

		try {
			const ip = getIPForRequest(this.app, req);

			const ipLimit = await this.consumeIpRateLimit(ip);
			if (!ipLimit.allowed) return this.rejectRateLimited(socket, ipLimit.retryAfterMs);

			const globalLimit = await this.consumeGlobalRateLimit();
			if (!globalLimit.allowed) return this.rejectRateLimited(socket, globalLimit.retryAfterMs);

			if (!this.isOriginAllowed(this.app, req)) return this.reject(socket, 403);

			if (this.hasQueryToken(req)) return this.reject(socket, 400);

			lease = this.admission.reserve(this.transport, ip);
			if (lease === null) return this.reject(socket, 503);

			auth = new ConnectionAuth(this.buildContext(ip, req), lease, { database: this.database });

			await this.authorize(req, socket, head, auth, ip);
		} catch {
			logger.debug(LOG_UPGRADE_FAILED);
			if (auth !== null) auth.close();
			else if (lease !== null) lease.close();
			this.reject(socket, 503);
		}
	}

	async terminate(): Promise<void> {
		this.closing = true;
		for (const client of [...this.clients]) this.stop(client, { terminate: true });
		await Promise.allSettled([...this.inflightUpgrades]);
		while (this.clients.size > 0) await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.allSettled([...this.inflightDrains]);
		await Promise.allSettled([...this.inflightAuth]);
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	closeConnection(client: SocketClient, code?: number): void {
		if (!this.clients.has(client)) return;
		this.stop(client, code !== undefined ? { code } : {});
	}

	broadcast(frame: string, filter?: { user?: string; role?: string }): void {
		for (const client of this.clients) {
			if (!client.lifecycleStarted || client.stopping || client.finalized) continue;

			const { accountability } = client.auth;
			if (filter?.user !== undefined && filter.user !== accountability.user) continue;
			if (filter?.role !== undefined && filter.role !== accountability.role) continue;

			this.send(client, frame);
		}
	}

	clientSnapshot(): Set<SocketClient> {
		return new Set(this.clients);
	}

	private trackAuth<T>(lookup: Promise<T>): Promise<T> {
		this.inflightAuth.add(lookup);
		void lookup.catch(() => undefined).finally(() => this.inflightAuth.delete(lookup));
		return lookup;
	}

	private async authorize(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		auth: ConnectionAuth,
		ip: string
	): Promise<void> {
		if (this.authMode === 'public') return this.establishAndConnect(req, socket, head, auth, ip);
		if (this.authMode === 'handshake') return this.establishForHandshake(req, socket, head, auth, ip);
		return this.authorizeStrict(req, socket, head, auth, ip);
	}

	private async authorizeStrict(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		auth: ConnectionAuth,
		ip: string
	): Promise<void> {
		const token = this.readBearer(req);

		if (token === null) {
			auth.close();
			return this.reject(socket, 401);
		}

		let onDisconnect!: () => void;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const disconnect = new Promise<StrictOutcome>((resolve) => {
			onDisconnect = () => resolve({ kind: 'disconnect' });
		});

		for (const event of DISCONNECT_EVENTS) socket.once(event, onDisconnect);

		const deadline = new Promise<StrictOutcome>((resolve) => {
			timer = setTimeout(() => resolve({ kind: 'timeout' }), this.authTimeoutMs);
		});

		const lookup: Promise<StrictOutcome> = this.trackAuth(auth.authenticate(token)).then(
			(result): StrictOutcome =>
				result.status === 'busy' || result.status === 'superseded'
					? { kind: 'error' }
					: { kind: 'result', status: result.status },
			(): StrictOutcome => ({ kind: 'error' })
		);

		const outcome = await Promise.race([lookup, deadline, disconnect]);

		if (timer !== undefined) clearTimeout(timer);
		for (const event of DISCONNECT_EVENTS) socket.off(event, onDisconnect);

		if (outcome.kind === 'disconnect') {
			auth.close();
			socket.destroy();
			return;
		}

		if (outcome.kind === 'timeout') {
			auth.close();
			return this.reject(socket, 401);
		}

		if (outcome.kind === 'error') {
			auth.close();
			return this.reject(socket, 503);
		}

		if (outcome.status === 'authenticated') return this.establishAndConnect(req, socket, head, auth, ip);

		auth.close();
		return this.reject(socket, outcome.status === 'capacity' ? 503 : 401);
	}

	private async establishAndConnect(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		auth: ConnectionAuth,
		ip: string
	): Promise<void> {
		let disconnected = false;

		const onDisconnect = () => {
			disconnected = true;
			socket.destroy();
		};

		for (const event of DISCONNECT_EVENTS) socket.once(event, onDisconnect);

		let schema: SchemaOverview;

		try {
			schema = await this.getSchema({ database: this.database });
		} finally {
			for (const event of DISCONNECT_EVENTS) socket.off(event, onDisconnect);
		}

		if (disconnected) {
			auth.close();
			return;
		}

		if (this.hasExpired(auth)) {
			auth.close();
			this.reject(socket, 401);
			return;
		}

		let established = false;

		this.server.handleUpgrade(req, socket, head, (ws) => {
			established = true;

			if (this.closing) {
				auth.close();
				ws.terminate();
				return;
			}

			const client = this.createClient(ws, auth, ip);
			client.schema = schema;
			this.clients.add(client);
			client.lifecycleStarted = true;
			this.emitEvent('websocket.connect', client);
			client.onExpiry = this.buildOnExpiry(client);
			this.armExpiryTimer(client);

			client.heartbeatStop = startHeartbeat(client, this.heartbeatPeriodMs, () =>
				this.stop(client, { terminate: true })
			);
		});

		if (!established) auth.close();
	}

	private establishForHandshake(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		auth: ConnectionAuth,
		ip: string
	): void {
		let established = false;

		this.server.handleUpgrade(req, socket, head, (ws) => {
			established = true;

			if (this.closing) {
				auth.close();
				ws.terminate();
				return;
			}

			const client = this.createClient(ws, auth, ip);
			this.clients.add(client);
			this.armHandshakeDeadline(client);

			client.heartbeatStop = startHeartbeat(client, this.heartbeatPeriodMs, () =>
				this.stop(client, { terminate: true })
			);
		});

		if (!established) auth.close();
	}

	protected createClient(ws: WebSocket, auth: ConnectionAuth, ip: string): SocketClient {
		const client = ws as SocketClient;
		client.uid = uuid();
		client.auth = auth;
		client.schema = null;
		client.onExpiry = () => undefined;
		client.expiryTimer = null;
		client.handshakeTimer = null;
		client.lifecycleStarted = false;
		client.stopping = false;
		client.finalized = false;
		client.finalizationHold = null;
		client.heartbeatStop = null;

		this.connectionState.set(client, {
			ip,
			origin: this.authMode,
			waiting: [],
			retainedBytes: 0,
			draining: false,
		});

		ws.on('message', (data: RawData) => this.admit(client, data));

		ws.on('error', (error: Error) => {
			if (client.lifecycleStarted && !client.finalized) this.emitEvent('websocket.error', client, { error });

			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
				this.stop(client, { terminate: true });
			}
		});

		ws.on('close', (code: number, reason: Buffer) => this.finalizeClient(client, code, reason.toString()));

		auth.setInvalidationHandler(() => this.handleExpiry(client));

		return client;
	}

	private discardWaiting(client: SocketClient): void {
		const state = this.connectionState.get(client);
		if (state === undefined) return;

		for (const frame of state.waiting) state.retainedBytes -= frame.length;
		state.waiting.length = 0;
	}

	private clearTimers(client: SocketClient): void {
		if (client.expiryTimer !== null) {
			clearTimeout(client.expiryTimer);
			client.expiryTimer = null;
		}

		if (client.handshakeTimer !== null) {
			clearTimeout(client.handshakeTimer);
			client.handshakeTimer = null;
		}
	}

	protected stop(client: SocketClient, options: { code?: number; reason?: string; terminate?: boolean } = {}): void {
		if (client.stopping) {
			if (options.terminate) client.terminate();
			return;
		}

		client.stopping = true;

		// Retain admission until the socket actually closes, but invalidate the auth generation now
		// so an in-flight lookup settling before the close event cannot commit a late identity.
		client.finalizationHold = client.auth.beginWorkHold();
		client.auth.close();
		this.clearTimers(client);
		this.discardWaiting(client);

		try {
			if (options.terminate) client.terminate();
			else if (options.code !== undefined) client.close(options.code, options.reason);
			else client.close();
		} catch {
			client.terminate();
		}
	}

	private finalizeClient(client: SocketClient, code?: number, reason?: string): void {
		if (client.finalized) return;
		client.finalized = true;
		client.stopping = true;

		this.clearTimers(client);

		if (client.heartbeatStop !== null) {
			client.heartbeatStop();
			client.heartbeatStop = null;
		}

		this.discardWaiting(client);
		this.subscriptions.removeAllForClient(client);

		client.auth.close();

		if (client.finalizationHold !== null) {
			client.finalizationHold.clear();
			client.finalizationHold = null;
		}

		if (client.lifecycleStarted) this.emitEvent('websocket.close', client, { code, reason });

		this.clients.delete(client);
	}

	protected buildOnExpiry(_client: SocketClient): () => void {
		return () => undefined;
	}

	private hasExpired(auth: ConnectionAuth): boolean {
		return auth.expiresAt !== null && auth.expiresAt * 1000 <= Date.now();
	}

	private armHandshakeDeadline(client: SocketClient): void {
		client.handshakeTimer = setTimeout(() => {
			client.handshakeTimer = null;
			this.stop(client);
		}, this.authTimeoutMs);
	}

	private armExpiryTimer(client: SocketClient): void {
		if (client.expiryTimer !== null) {
			clearTimeout(client.expiryTimer);
			client.expiryTimer = null;
		}

		const expiresAt = client.auth.expiresAt;
		if (expiresAt === null) return;

		const schedule = () => {
			const remainingMs = expiresAt * 1000 - Date.now();

			if (remainingMs <= 0) {
				client.expiryTimer = null;
				this.handleExpiry(client);
				return;
			}

			client.expiryTimer = setTimeout(schedule, Math.min(remainingMs, TIMER_MAX_MS));
		};

		schedule();
	}

	private handleExpiry(client: SocketClient): void {
		try {
			client.onExpiry();
		} catch {
			logger.debug(LOG_EXPIRY_NOTICE_FAILED);
		} finally {
			if (this.authMode === 'public') {
				const result = client.auth.supersedeToAnonymous();
				if (result.status === 'capacity') this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
			} else {
				this.stop(client);
			}
		}
	}

	private emitEvent(event: string, client: SocketClient, extra: Record<string, unknown> = {}): void {
		void this.emitEventAwaited(event, client, extra);
	}

	private emitEventAwaited(event: string, client: SocketClient, extra: Record<string, unknown> = {}): Promise<void> {
		return emitter.emitActionBounded(
			event,
			{ client, ...extra },
			{ database: this.database, schema: client.schema, accountability: client.auth.accountability }
		);
	}

	private admit(client: SocketClient, data: RawData): void {
		const state = this.connectionState.get(client);
		if (state === undefined || client.stopping || this.closing) return;

		if (state.waiting.length >= PENDING_COMMAND_LIMIT) {
			this.send(client, this.errorFrame('TOO_MANY_PENDING'));
			this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
			return;
		}

		const frame = toBuffer(data);
		state.waiting.push(frame);
		state.retainedBytes += frame.length;

		const drain = this.drain(client, state);
		this.inflightDrains.add(drain);
		void drain.finally(() => this.inflightDrains.delete(drain));
	}

	private async drain(client: SocketClient, state: ConnectionState): Promise<void> {
		if (state.draining) return;
		state.draining = true;

		try {
			while (state.waiting.length > 0 && !client.stopping) {
				const frame = state.waiting.shift()!;
				const hold = client.auth.beginWorkHold();

				if (hold === null) {
					state.retainedBytes -= frame.length;
					break;
				}

				try {
					await this.processFrame(client, state, frame);
				} catch (error) {
					if (!client.stopping) this.send(client, toWebSocketException(error, 'server').toMessage());
				} finally {
					hold.clear();
					state.retainedBytes -= frame.length;
				}
			}
		} finally {
			state.draining = false;
		}
	}

	private async processFrame(client: SocketClient, state: ConnectionState, frame: Buffer): Promise<void> {
		const preConnect = !client.lifecycleStarted;

		const ipLimit = await this.consumeIpRateLimit(state.ip);
		if (!ipLimit.allowed) return this.rejectRateLimitedMessage(client, preConnect);

		const globalLimit = await this.consumeGlobalRateLimit();
		if (!globalLimit.allowed) return this.rejectRateLimitedMessage(client, preConnect);

		if (client.stopping) return;

		let message: WebSocketMessage;

		try {
			message = WebSocketMessage.parse(parseJSON(frame.toString()));
		} catch {
			return this.rejectMalformedFrame(client, preConnect);
		}

		await this.routeMessage(client, message);
	}

	protected async routeMessage(client: SocketClient, message: WebSocketMessage): Promise<void> {
		const type = getMessageType(message);

		if (type === 'auth') return this.handleAuth(client, message);

		if (!client.lifecycleStarted) return this.failHandshake(client, 'AUTH_FAILED', message.uid);

		const handler = this.handlers.get(type);
		if (handler === undefined) return void this.send(client, this.errorFrame('UNSUPPORTED_MESSAGE_TYPE', message.uid));

		await this.runCommand(client, message, handler);
	}

	private async runCommand(client: SocketClient, message: WebSocketMessage, handler: CommandHandler): Promise<void> {
		const filtered = WebSocketMessage.parse(
			await emitter.emitFilter('websocket.message', message, { client }, this.eventContext(client))
		);

		if (getMessageType(filtered) !== getMessageType(message)) {
			return void this.send(client, this.errorFrame('INVALID_PAYLOAD', message.uid));
		}

		const schema = await this.getSchema({ database: this.database });
		if (client.stopping) return;

		if (!(await this.refreshBeforeCommand(client, schema)) || client.stopping) return;

		await handler(client, filtered, { schema, accountability: client.auth.accountability });

		if (client.stopping) return;
		await this.emitEventAwaited('websocket.message', client, { message: filtered });
	}

	protected async refreshBeforeCommand(client: SocketClient, schema: SchemaOverview): Promise<boolean> {
		return client.auth.refreshPermissions(schema);
	}

	protected rejectRateLimitedMessage(client: SocketClient, preConnect: boolean): void {
		this.send(client, this.errorFrame('REQUESTS_EXCEEDED'));
		if (preConnect) this.stop(client);
	}

	protected rejectMalformedFrame(client: SocketClient, preConnect: boolean): void {
		if (preConnect) return this.failHandshake(client, 'AUTH_FAILED');
		this.send(client, this.errorFrame('INVALID_PAYLOAD'));
	}

	private async handleAuth(client: SocketClient, message: WebSocketMessage): Promise<void> {
		const uid = message.uid;

		let parsed: WebSocketAuthMessage;

		try {
			parsed = WebSocketAuthMessage.parse(message);
		} catch {
			return this.rejectAuth(client, { status: 'rejected', reason: 'auth-failed' }, uid);
		}

		const outcome = await this.authenticateConnection(client, parsed.access_token, uid);

		if (outcome.status === 'authenticated' || outcome.status === 'ignored') return;

		return this.rejectAuth(client, outcome, uid);
	}

	protected async authenticateConnection(
		client: SocketClient,
		token: string,
		uid: string | number | undefined
	): Promise<AuthOutcome> {
		const preConnect = !client.lifecycleStarted;
		const result = await this.authenticateWithDeadline(client.auth, token);

		if (client.stopping || result.status === 'busy' || result.status === 'superseded') return { status: 'ignored' };

		if (result.status === 'authenticated') {
			const committed = await this.applyAuthSuccess(client, preConnect, uid);
			return { status: committed ? 'authenticated' : 'ignored' };
		}

		if (result.status === 'timeout') return { status: 'timeout' };

		if (result.status === 'capacity') return { status: 'capacity' };

		return { status: 'rejected', reason: result.reason };
	}

	private async rejectAuth(
		client: SocketClient,
		outcome: AuthFailureOutcome,
		uid: string | number | undefined
	): Promise<void> {
		const state = this.connectionState.get(client);
		if (state === undefined) return;

		const preConnect = !client.lifecycleStarted;

		if (outcome.status === 'timeout') return this.applyAuthTimeout(client, state, preConnect);

		if (outcome.status === 'capacity') {
			this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
			return;
		}

		if (outcome.reason === 'different-user') {
			this.send(client, this.errorFrame('AUTH_FAILED', uid, 'auth'));
			this.stop(client);
			return;
		}

		const code: WebSocketErrorCode = outcome.reason === 'token-expired' ? 'TOKEN_EXPIRED' : 'AUTH_FAILED';
		return this.applyAuthReject(client, state, preConnect, code, uid);
	}

	private async authenticateWithDeadline(
		auth: ConnectionAuth,
		token: string
	): Promise<AuthResult | { status: 'timeout' }> {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const deadline = new Promise<{ status: 'timeout' }>((resolve) => {
			timer = setTimeout(() => resolve({ status: 'timeout' }), this.authTimeoutMs);
		});

		const lookup: Promise<AuthResult> = this.trackAuth(auth.authenticate(token)).then(
			(result) => result,
			(): AuthResult => ({ status: 'rejected', reason: 'auth-failed' })
		);

		const result = await Promise.race([lookup, deadline]);
		if (timer !== undefined) clearTimeout(timer);
		return result;
	}

	private async applyAuthSuccess(
		client: SocketClient,
		preConnect: boolean,
		uid: string | number | undefined
	): Promise<boolean> {
		if (preConnect) {
			const hold = client.auth.beginWorkHold();
			if (hold === null) return false;

			try {
				const schema = await this.getSchema({ database: this.database });
				if (client.stopping) return false;
				if (!this.sendAuthSuccess(client, uid).accepted) return false;

				client.schema = schema;
				client.lifecycleStarted = true;
				this.emitEvent('websocket.connect', client);
				client.onExpiry = this.buildOnExpiry(client);
				this.armExpiryTimer(client);

				if (client.handshakeTimer !== null) {
					clearTimeout(client.handshakeTimer);
					client.handshakeTimer = null;
				}

				return true;
			} finally {
				hold.clear();
			}
		}

		if (!this.sendAuthSuccess(client, uid).accepted) return false;

		client.onExpiry = this.buildOnExpiry(client);
		this.armExpiryTimer(client);
		await this.emitEventAwaited('websocket.auth.success', client);
		return true;
	}

	private async applyAuthReject(
		client: SocketClient,
		state: ConnectionState,
		preConnect: boolean,
		code: WebSocketErrorCode,
		uid: string | number | undefined
	): Promise<void> {
		if (preConnect || state.origin !== 'public') {
			this.send(client, this.errorFrame(code, uid, 'auth'));
			this.stop(client);
			return;
		}

		const revert = client.auth.revertToAnonymous();

		if (revert.status === 'capacity') {
			this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
			return;
		}

		if (client.expiryTimer !== null) {
			clearTimeout(client.expiryTimer);
			client.expiryTimer = null;
		}

		this.send(client, this.errorFrame(code, uid, 'auth'));
		await this.emitEventAwaited('websocket.auth.failure', client);
	}

	private applyAuthTimeout(client: SocketClient, state: ConnectionState, preConnect: boolean): void {
		if (preConnect || state.origin !== 'public') {
			this.stop(client);
			return;
		}

		const revert = client.auth.supersedeToAnonymous();

		if (revert.status === 'capacity') {
			this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
			return;
		}

		if (client.expiryTimer !== null) {
			clearTimeout(client.expiryTimer);
			client.expiryTimer = null;
		}
	}

	private failHandshake(client: SocketClient, code: WebSocketErrorCode, uid?: string | number): void {
		this.send(client, this.errorFrame(code, uid, 'auth'));
		this.stop(client);
	}

	protected send(client: SocketClient, frame: string): { accepted: boolean } {
		return safeSend(client, frame, OUTBOUND_LIMITS, (code) => this.stop(client, code === undefined ? {} : { code }));
	}

	protected sendAuthSuccess(client: SocketClient, uid: string | number | undefined): { accepted: boolean } {
		return this.send(client, this.authSuccessFrame(uid));
	}

	protected errorFrame(code: WebSocketErrorCode, uid?: string | number, type = 'server'): string {
		return new WebSocketException(type, code, uid).toMessage();
	}

	private authSuccessFrame(uid?: string | number): string {
		return fmtMessage('auth', { status: 'ok' }, uid);
	}

	private eventContext(client: SocketClient) {
		return { database: this.database, schema: client.schema, accountability: client.auth.accountability };
	}

	private buildContext(ip: string, req: IncomingMessage): RequestContext {
		const userAgent = req.headers['user-agent'];
		const origin = req.headers['origin'];

		return {
			ip,
			userAgent: typeof userAgent === 'string' ? userAgent : null,
			origin: typeof origin === 'string' ? origin : null,
		};
	}

	private readBearer(req: IncomingMessage): string | null {
		const header = req.headers['authorization'];
		if (typeof header !== 'string') return null;

		const match = /^Bearer\s+(.+)$/i.exec(header);
		return match ? match[1]!.trim() : null;
	}

	private matchesPath(req: IncomingMessage): boolean {
		try {
			return this.parseUrl(req).pathname === this.path;
		} catch {
			return false;
		}
	}

	private hasQueryToken(req: IncomingMessage): boolean {
		return this.parseUrl(req).searchParams.has('access_token');
	}

	private parseUrl(req: IncomingMessage): URL {
		return new URL(req.url ?? '', 'http://localhost');
	}

	private reject(socket: Duplex, status: number): void {
		if (!socket.writable) return;
		socket.write(`HTTP/1.1 ${status} ${REASON[status]}\r\n\r\n`);
		socket.destroy();
	}

	private rejectRateLimited(socket: Duplex, retryAfterMs: number): void {
		if (!socket.writable) return;
		const retryAfter = Math.max(1, Math.round(retryAfterMs / 1000));
		socket.write(`HTTP/1.1 429 ${REASON[429]}\r\nRetry-After: ${retryAfter}\r\n\r\n`);
		socket.destroy();
	}
}
