import type { SchemaOverview } from '@cairncms/types';
import type { Application } from 'express';
import type { Knex } from 'knex';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { v4 as uuid } from 'uuid';
import { WebSocket, WebSocketServer } from 'ws';
import emitter from '../../emitter.js';
import logger from '../../logger.js';
import type { RateLimitConsumption } from '../../middleware/rate-limiter-ip.js';
import type { RequestContext } from '../../utils/get-anonymous-accountability.js';
import { getIPForRequest } from '../../utils/get-ip-from-req.js';
import type { Admission, Lease } from '../admission.js';
import { ConnectionAuth } from '../authenticate.js';
import { TIMER_MAX_MS, type AuthMode } from '../config.js';

const LOG_UPGRADE_FAILED = 'WebSocket upgrade failed';
const LOG_EXPIRY_NOTICE_FAILED = 'WebSocket expiry notice failed';

const CLOSE_TRY_AGAIN_LATER = 1013;

const DISCONNECT_EVENTS = ['close', 'error', 'end'] as const;

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
}

export type SocketClient = WebSocket & {
	uid: string;
	auth: ConnectionAuth;
	schema: SchemaOverview | null;
	onExpiry: () => void;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	handshakeTimer: ReturnType<typeof setTimeout> | null;
	lifecycleStarted: boolean;
	finalized: boolean;
};

type StrictOutcome =
	| { kind: 'result'; status: 'authenticated' | 'capacity' | 'rejected' }
	| { kind: 'timeout' }
	| { kind: 'disconnect' }
	| { kind: 'error' };

export abstract class SocketController {
	protected readonly server: WebSocketServer;
	protected readonly clients: Set<SocketClient> = new Set();

	protected readonly transport: string;
	protected readonly path: string;
	protected readonly authMode: AuthMode;
	protected readonly authTimeoutMs: number;

	protected readonly admission: Admission;
	protected readonly isOriginAllowed: (app: Application, req: IncomingMessage) => boolean;
	protected readonly consumeIpRateLimit: (ip: string) => Promise<RateLimitConsumption>;
	protected readonly consumeGlobalRateLimit: () => Promise<RateLimitConsumption>;
	protected readonly app: Application;
	protected readonly database: Knex;
	protected readonly getSchema: (options?: { database?: Knex }) => Promise<SchemaOverview>;

	constructor(options: SocketControllerOptions) {
		this.transport = options.transport;
		this.path = options.path;
		this.authMode = options.authMode;
		this.authTimeoutMs = options.authTimeoutMs;
		this.admission = options.admission;
		this.isOriginAllowed = options.isOriginAllowed;
		this.consumeIpRateLimit = options.consumeIpRateLimit;
		this.consumeGlobalRateLimit = options.consumeGlobalRateLimit;
		this.app = options.app;
		this.database = options.database;
		this.getSchema = options.getSchema;
		this.server = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload });
	}

	handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
		if (!this.matchesPath(req)) return;

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

			await this.authorize(req, socket, head, auth);
		} catch {
			logger.debug(LOG_UPGRADE_FAILED);
			if (auth !== null) auth.close();
			else if (lease !== null) lease.close();
			this.reject(socket, 503);
		}
	};

	async terminate(): Promise<void> {
		for (const client of [...this.clients]) client.terminate();
		while (this.clients.size > 0) await new Promise<void>((resolve) => setImmediate(resolve));
		this.server.close();
	}

	private async authorize(req: IncomingMessage, socket: Duplex, head: Buffer, auth: ConnectionAuth): Promise<void> {
		if (this.authMode === 'public') return this.establishAndConnect(req, socket, head, auth);
		if (this.authMode === 'handshake') return this.establishForHandshake(req, socket, head, auth);
		return this.authorizeStrict(req, socket, head, auth);
	}

	private async authorizeStrict(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		auth: ConnectionAuth
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

		const lookup: Promise<StrictOutcome> = auth.authenticate(token).then(
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

		if (outcome.status === 'authenticated') return this.establishAndConnect(req, socket, head, auth);

		auth.close();
		return this.reject(socket, outcome.status === 'capacity' ? 503 : 401);
	}

	private async establishAndConnect(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		auth: ConnectionAuth
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

		this.server.handleUpgrade(req, socket, head, (ws) => {
			const client = this.createClient(ws, auth);
			client.schema = schema;
			this.clients.add(client);
			client.lifecycleStarted = true;
			this.emitEvent('websocket.connect', client);
			client.onExpiry = this.buildOnExpiry(client);
			this.armExpiryTimer(client);
		});
	}

	private establishForHandshake(req: IncomingMessage, socket: Duplex, head: Buffer, auth: ConnectionAuth): void {
		this.server.handleUpgrade(req, socket, head, (ws) => {
			const client = this.createClient(ws, auth);
			this.clients.add(client);
			this.armHandshakeDeadline(client);
		});
	}

	protected createClient(ws: WebSocket, auth: ConnectionAuth): SocketClient {
		const client = ws as SocketClient;
		client.uid = uuid();
		client.auth = auth;
		client.schema = null;
		client.onExpiry = () => undefined;
		client.expiryTimer = null;
		client.handshakeTimer = null;
		client.lifecycleStarted = false;
		client.finalized = false;

		ws.on('error', (error: Error) => {
			if (client.lifecycleStarted && !client.finalized) this.emitEvent('websocket.error', client, { error });
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.terminate();
		});

		ws.on('close', (code: number, reason: Buffer) => this.finalizeClient(client, code, reason.toString()));

		return client;
	}

	private finalizeClient(client: SocketClient, code?: number, reason?: string): void {
		if (client.finalized) return;
		client.finalized = true;

		if (client.expiryTimer !== null) {
			clearTimeout(client.expiryTimer);
			client.expiryTimer = null;
		}

		if (client.handshakeTimer !== null) {
			clearTimeout(client.handshakeTimer);
			client.handshakeTimer = null;
		}

		client.auth.close();

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
			client.close();
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
				if (result.status === 'capacity') client.close(CLOSE_TRY_AGAIN_LATER);
			} else {
				client.close();
			}
		}
	}

	private emitEvent(event: string, client: SocketClient, extra: Record<string, unknown> = {}): void {
		emitter.emitAction(
			event,
			{ client, ...extra },
			{ database: this.database, schema: client.schema, accountability: client.auth.accountability }
		);
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
