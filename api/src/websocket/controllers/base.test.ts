import type { SchemaOverview } from '@cairncms/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import emitter from '../../emitter.js';
import { getEnv } from '../../env.js';
import logger from '../../logger.js';
import type { RateLimitConsumption } from '../../middleware/rate-limiter-ip.js';
import { Admission } from '../admission.js';
import { PENDING_COMMAND_LIMIT, TIMER_MAX_MS, type AuthMode } from '../config.js';
import { WebSocketException } from '../exceptions.js';
import { SubscriptionRegistry } from '../subscriptions.js';
import type { CommandContext, SocketClient, SocketControllerOptions } from './base.js';
import { WebSocketController } from './rest.js';

class TestController extends WebSocketController {
	public expiryBehavior: () => void = () => undefined;
	public commandGate: (() => Promise<void>) | null = null;
	public commandLog: (string | number | undefined)[] = [];
	public handlerError: Error | null = null;
	public refreshGate: (() => Promise<boolean>) | null = null;
	public lastContext: CommandContext | null = null;

	public get clientCount(): number {
		return this.clients.size;
	}

	public stopClient(client: SocketClient, options?: { code?: number; terminate?: boolean }): void {
		this.stop(client, options);
	}

	constructor(options: SocketControllerOptions) {
		super(options);

		this.handlers.set('test', async (_client, message, context) => {
			this.commandLog.push(message.uid);
			this.lastContext = context;
			if (this.commandGate) await this.commandGate();
			if (this.handlerError) throw this.handlerError;
		});
	}

	protected override buildOnExpiry(_client: SocketClient): () => void {
		return () => this.expiryBehavior();
	}

	protected override async refreshBeforeCommand(): Promise<boolean> {
		return this.refreshGate ? this.refreshGate() : true;
	}
}

const SCHEMA = { collections: {}, relations: [] } as unknown as SchemaOverview;

function secret(): string {
	return String(getEnv()['SECRET']);
}

function signUser(user: string, options: jwt.SignOptions = {}): string {
	return jwt.sign({ id: user, role: 'role-1', app_access: true, admin_access: false }, secret(), {
		issuer: 'cairncms',
		expiresIn: '1h',
		...options,
	});
}

function signShare(): string {
	return jwt.sign({ share: 'share-1', role: 'role-1', app_access: false, admin_access: false }, secret(), {
		issuer: 'cairncms',
		expiresIn: '1h',
	});
}

function signInvalid(): string {
	return jwt.sign({ id: 'alice', role: 'role-1', app_access: true, admin_access: false }, 'wrong-secret', {
		issuer: 'cairncms',
	});
}

interface HarnessOptions {
	authMode?: AuthMode;
	authTimeoutMs?: number;
	maxPayload?: number;
	admission?: Admission;
	isOriginAllowed?: () => boolean;
	consumeIpRateLimit?: (ip: string) => Promise<RateLimitConsumption>;
	consumeGlobalRateLimit?: () => Promise<RateLimitConsumption>;
	database?: Knex;
	getSchema?: () => Promise<SchemaOverview>;
	subscriptions?: SubscriptionRegistry;
	controllerClass?: new (options: SocketControllerOptions) => WebSocketController;
}

interface Harness {
	admission: Admission;
	subscriptions: SubscriptionRegistry;
	controller: WebSocketController;
	server: Server;
	port: number;
	sockets: WebSocket[];
	nextRawSocket: () => Promise<Duplex>;
	connect: (options?: ConnectOptions) => Promise<ConnectResult>;
	teardown: () => Promise<void>;
}

interface ConnectOptions {
	path?: string;
	headers?: Record<string, string>;
}

type ConnectResult =
	| { kind: 'open'; ws: WebSocket }
	| { kind: 'reject'; status: number; headers: IncomingHttpHeaders; body: string };

let emitActionBounded: ReturnType<typeof vi.spyOn>;

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const admission = options.admission ?? new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 100 } });
	const subscriptions = options.subscriptions ?? new SubscriptionRegistry();

	const ControllerClass = options.controllerClass ?? WebSocketController;

	const controller = new ControllerClass({
		transport: 'rest',
		path: '/websocket',
		authMode: options.authMode ?? 'public',
		authTimeoutMs: options.authTimeoutMs ?? 10_000,
		maxPayload: options.maxPayload ?? 1_048_576,
		heartbeatPeriodMs: 30_000,
		admission,
		isOriginAllowed: options.isOriginAllowed ?? (() => true),
		consumeIpRateLimit: options.consumeIpRateLimit ?? (async () => ({ allowed: true })),
		consumeGlobalRateLimit: options.consumeGlobalRateLimit ?? (async () => ({ allowed: true })),
		app: express(),
		database: options.database ?? ({} as Knex),
		getSchema: options.getSchema ?? (async () => SCHEMA),
		subscriptions,
	});

	const server = createServer();
	server.on('upgrade', controller.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as AddressInfo).port;

	const nextRawSocket = (): Promise<Duplex> =>
		new Promise((resolve) => server.once('upgrade', (_req, socket) => resolve(socket)));

	const sockets: WebSocket[] = [];

	const connect = (connectOptions: ConnectOptions = {}): Promise<ConnectResult> =>
		new Promise((resolve, reject) => {
			const url = `ws://127.0.0.1:${port}${connectOptions.path ?? '/websocket'}`;
			const ws = new WebSocket(url, { headers: connectOptions.headers });
			sockets.push(ws);
			let settled = false;

			ws.on('open', () => {
				if (settled) return;
				settled = true;
				resolve({ kind: 'open', ws });
			});

			ws.on('unexpected-response', (_req, res) => {
				if (settled) return;
				settled = true;
				const chunks: Buffer[] = [];
				let done = false;

				const finish = () => {
					if (done) return;
					done = true;

					resolve({
						kind: 'reject',
						status: res.statusCode!,
						headers: res.headers,
						body: Buffer.concat(chunks).toString(),
					});
				};

				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', finish);
				res.on('close', finish);
			});

			ws.on('error', (error) => {
				if (settled) return;
				settled = true;
				reject(error);
			});
		});

	const teardown = async () => {
		for (const ws of sockets) ws.terminate();
		await controller.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { admission, subscriptions, controller, server, port, sockets, nextRawSocket, connect, teardown };
}

function callsFor(event: string): unknown[][] {
	return emitActionBounded.mock.calls.filter((call) => call[0] === event);
}

function deferred<T>() {
	let resolve!: (value: T) => void;

	const promise = new Promise<T>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

function deferredDatabase() {
	const gate = deferred<undefined>();
	const calledGate = deferred<void>();

	const chain: Record<string, unknown> = {
		select: () => chain,
		from: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		first: () => {
			calledGate.resolve();
			return gate.promise;
		},
	};

	return { database: chain as unknown as Knex, resolve: () => gate.resolve(undefined), called: calledGate.promise };
}

function deferredUserDatabase(user: string) {
	const gate = deferred<{ id: string; role: string; admin_access: boolean; app_access: boolean }>();
	const calledGate = deferred<void>();

	const chain: Record<string, unknown> = {
		select: () => chain,
		from: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		first: () => {
			calledGate.resolve();
			return gate.promise;
		},
	};

	return {
		database: chain as unknown as Knex,
		resolve: () => gate.resolve({ id: user, role: 'role-1', admin_access: false, app_access: true }),
		called: calledGate.promise,
	};
}

function deferredSchema() {
	const gate = deferred<SchemaOverview>();
	const calledGate = deferred<void>();

	return {
		getSchema: async () => {
			calledGate.resolve();
			return gate.promise;
		},
		resolve: () => gate.resolve(SCHEMA),
		called: calledGate.promise,
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function collect(ws: WebSocket): Record<string, any>[] {
	const frames: Record<string, any>[] = [];
	ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
	return frames;
}

function sendJson(ws: WebSocket, message: Record<string, unknown>): void {
	ws.send(JSON.stringify(message));
}

async function waitFrames(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 2000 && !predicate(); i++) await new Promise((resolve) => setImmediate(resolve));
}

let harness: Harness | null = null;

beforeEach(() => {
	emitActionBounded = vi.spyOn(emitter, 'emitActionBounded');
});

afterEach(async () => {
	if (harness) await harness.teardown();
	harness = null;
	emitActionBounded.mockRestore();
	vi.useRealTimers();
});

describe('upgrade rejection contract', () => {
	it('accepts a public upgrade on the owned path', async () => {
		harness = await createHarness();
		const result = await harness.connect();
		expect(result.kind).toBe('open');
	});

	it('leaves a non-matching path untouched for another listener', async () => {
		const controller = new WebSocketController({
			transport: 'rest',
			path: '/websocket',
			authMode: 'public',
			authTimeoutMs: 10_000,
			maxPayload: 1_048_576,
			heartbeatPeriodMs: 30_000,
			admission: new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 100 } }),
			isOriginAllowed: () => true,
			consumeIpRateLimit: async () => ({ allowed: true }),
			consumeGlobalRateLimit: async () => ({ allowed: true }),
			app: express(),
			database: {} as Knex,
			getSchema: async () => SCHEMA,
			subscriptions: new SubscriptionRegistry(),
		});

		const server = createServer();
		server.on('upgrade', controller.handleUpgrade);

		server.on('upgrade', (req, socket) => {
			if (new URL(req.url ?? '', 'http://localhost').pathname === '/websocket') return;
			socket.write('HTTP/1.1 418 I am a teapot\r\n\r\n');
			socket.destroy();
		});

		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as AddressInfo).port;

		try {
			const status = await new Promise<number>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);

				ws.on('unexpected-response', (_req, res) => {
					res.resume();
					resolve(res.statusCode!);
				});

				ws.on('open', () => reject(new Error('unexpected open')));
			});

			expect(status).toBe(418);
		} finally {
			await controller.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('rejects an admission-capacity failure with a content-free 503', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		admission.reserve('rest', '9.9.9.9');
		harness = await createHarness({ admission });

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 503, body: '' });
	});

	it('rejects an exhausted IP budget with 429 and Retry-After', async () => {
		harness = await createHarness({ consumeIpRateLimit: async () => ({ allowed: false, retryAfterMs: 5000 }) });

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 429 });
		if (result.kind === 'reject') expect(result.headers['retry-after']).toBe('5');
	});

	it('rejects an exhausted global budget with 429', async () => {
		harness = await createHarness({ consumeGlobalRateLimit: async () => ({ allowed: false, retryAfterMs: 3000 }) });

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 429 });
	});

	it('consumes the limiter before origin and admission', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		admission.reserve('rest', '9.9.9.9');

		harness = await createHarness({
			admission,
			isOriginAllowed: () => false,
			consumeIpRateLimit: async () => ({ allowed: false, retryAfterMs: 1000 }),
		});

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 429 });
	});

	it('consumes a shared-budget unit per attempt before authentication, then rejects with 429', async () => {
		let budget = 2;

		const consumeIpRateLimit = async () =>
			budget-- > 0 ? { allowed: true as const } : { allowed: false as const, retryAfterMs: 1000 };

		harness = await createHarness({ authMode: 'strict', consumeIpRateLimit });

		const headers = { authorization: `Bearer ${signInvalid()}` };
		expect(await harness.connect({ headers })).toMatchObject({ kind: 'reject', status: 401 });
		expect(await harness.connect({ headers })).toMatchObject({ kind: 'reject', status: 401 });
		expect(await harness.connect({ headers })).toMatchObject({ kind: 'reject', status: 429 });
	});

	it('leaks no token or accountability into a response body or log across success and failures', async () => {
		const debug = vi.spyOn(logger, 'debug');
		const trace = vi.spyOn(logger, 'trace');
		const validToken = signUser('alice');
		const invalidToken = signInvalid();
		harness = await createHarness({ authMode: 'strict' });

		try {
			expect((await harness.connect({ headers: { authorization: `Bearer ${validToken}` } })).kind).toBe('open');

			const failures = [
				await harness.connect({ headers: { authorization: `Bearer ${invalidToken}` } }),
				await harness.connect({
					path: `/websocket?access_token=${validToken}`,
					headers: { authorization: `Bearer ${validToken}` },
				}),
			];

			for (const failure of failures) {
				expect(failure.kind).toBe('reject');
				if (failure.kind === 'reject') expect(failure.body).toBe('');
			}

			const logged = [...debug.mock.calls, ...trace.mock.calls].flat().map(String).join(' ');
			for (const secret of [validToken, invalidToken, 'alice']) expect(logged).not.toContain(secret);
		} finally {
			debug.mockRestore();
			trace.mockRestore();
		}
	});

	it('rejects a disallowed origin with 403', async () => {
		harness = await createHarness({ isOriginAllowed: () => false });

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 403, body: '' });
	});

	it('rejects a query access_token before the auth mode, even with a valid Bearer', async () => {
		for (const authMode of ['public', 'handshake', 'strict'] as const) {
			const local = await createHarness({ authMode });

			try {
				const result = await local.connect({
					path: '/websocket?access_token=x',
					headers: { authorization: `Bearer ${signUser('alice')}` },
				});

				expect(result).toMatchObject({ kind: 'reject', status: 400, body: '' });
			} finally {
				await local.teardown();
			}
		}
	});
});

describe('strict authentication', () => {
	it('accepts a valid Bearer and pins the user on connect', async () => {
		harness = await createHarness({ authMode: 'strict' });

		const result = await harness.connect({ headers: { authorization: `Bearer ${signUser('alice')}` } });
		expect(result.kind).toBe('open');

		const connects = callsFor('websocket.connect');
		expect(connects).toHaveLength(1);
		expect((connects[0]![2] as { accountability: { user: string } }).accountability.user).toBe('alice');
	});

	it('rejects a missing, malformed, invalid, or userless Bearer with 401', async () => {
		for (const authorization of ['', 'Basic abc', `Bearer ${signInvalid()}`, `Bearer ${signShare()}`]) {
			const local = await createHarness({ authMode: 'strict' });

			try {
				const headers = authorization === '' ? {} : { authorization };
				const result = await local.connect({ headers });
				expect(result).toMatchObject({ kind: 'reject', status: 401, body: '' });
			} finally {
				await local.teardown();
			}
		}
	});

	it('does not call the HTTP authenticate hook during a socket upgrade', async () => {
		const filterSpy = vi.spyOn(emitter, 'emitFilter');
		harness = await createHarness({ authMode: 'strict' });

		await harness.connect({ headers: { authorization: `Bearer ${signUser('alice')}` } });

		expect(filterSpy.mock.calls.some((call) => call[0] === 'authenticate')).toBe(false);
		filterSpy.mockRestore();
	});

	it('rejects a full user bucket at strict authentication with 503, not 401', async () => {
		const admission = new Admission({ process: 100, ip: 100, user: 1, transports: { rest: 100 } });
		admission.reserve('rest', '9.9.9.9')!.transitionToUser('alice');
		harness = await createHarness({ authMode: 'strict', admission });

		const result = await harness.connect({ headers: { authorization: `Bearer ${signUser('alice')}` } });
		expect(result).toMatchObject({ kind: 'reject', status: 503 });
	});
});

describe('lifecycle events', () => {
	it('emits connect with anonymous accountability, then close, each once', async () => {
		harness = await createHarness();
		const result = await harness.connect();
		expect(result.kind).toBe('open');

		const connects = callsFor('websocket.connect');
		expect(connects).toHaveLength(1);
		const context = connects[0]![2] as { database: unknown; schema: unknown; accountability: { user: string | null } };
		expect(context.accountability.user).toBeNull();
		expect(context.schema).toBe(SCHEMA);

		if (result.kind === 'open') result.ws.close();
		await vi.waitFor(() => expect(callsFor('websocket.close')).toHaveLength(1));
		expect(callsFor('websocket.error')).toHaveLength(0);
	});

	it('emits no lifecycle events for a handshake that times out, and releases admission', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		harness = await createHarness({ authMode: 'handshake', authTimeoutMs: 50, admission });

		const result = await harness.connect();
		expect(result.kind).toBe('open');

		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
		expect(callsFor('websocket.connect')).toHaveLength(0);
		expect(callsFor('websocket.close')).toHaveLength(0);
		expect(callsFor('websocket.error')).toHaveLength(0);
	});

	it('carries the last-valid accountability, database, and close code on the strict close event', async () => {
		const database = {} as Knex;
		harness = await createHarness({ authMode: 'strict', database });

		const opened = await harness.connect({ headers: { authorization: `Bearer ${signUser('alice')}` } });
		expect(opened.kind).toBe('open');

		if (opened.kind === 'open') opened.ws.close(4001);
		await vi.waitFor(() => expect(callsFor('websocket.close')).toHaveLength(1));

		const close = callsFor('websocket.close')[0]!;
		const meta = close[1] as { client: unknown; code: number };
		const context = close[2] as { database: unknown; schema: unknown; accountability: { user: string } };
		expect(context.accountability.user).toBe('alice');
		expect(context.database).toBe(database);
		expect(context.schema).toBe(SCHEMA);
		expect(meta.code).toBe(4001);
	});
});

describe('bounded payload and IP counting', () => {
	it('closes a connection whose message exceeds the payload limit', async () => {
		harness = await createHarness({ maxPayload: 16 });
		const result = await harness.connect();
		expect(result.kind).toBe('open');

		const closed = new Promise<number>((resolve) => {
			if (result.kind === 'open') result.ws.on('close', (code) => resolve(code));
		});

		if (result.kind === 'open') result.ws.send(Buffer.alloc(64));
		expect(await closed).toBe(1009);
	});

	it('keeps admission occupied on a server-side error until the close finalizer runs', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const database = {} as Knex;
		harness = await createHarness({ authMode: 'strict', admission, database });

		const opened = await harness.connect({ headers: { authorization: `Bearer ${signUser('alice')}` } });
		expect(opened.kind).toBe('open');

		const serverWs = (callsFor('websocket.connect')[0]![1] as { client: WebSocket }).client;
		serverWs.emit('error', new Error('boom'));

		const error = callsFor('websocket.error')[0]!;
		const meta = error[1] as { error: Error };
		const context = error[2] as { database: unknown; schema: unknown; accountability: { user: string } };
		expect(meta.error).toBeInstanceOf(Error);
		expect(context.database).toBe(database);
		expect(context.schema).toBe(SCHEMA);
		expect(context.accountability.user).toBe('alice');
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();

		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
	});

	it('counts concurrent connections from the same IP against the per-IP limit', async () => {
		const admission = new Admission({ process: 100, ip: 1, user: 100, transports: { rest: 100 } });
		harness = await createHarness({ admission });

		const first = await harness.connect();
		expect(first.kind).toBe('open');

		const second = await harness.connect();
		expect(second).toMatchObject({ kind: 'reject', status: 503 });
	});
});

describe('total upgrade boundary', () => {
	it('rejects with 503 and releases the lease when the limiter dependency throws', async () => {
		const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 100 } });

		harness = await createHarness({
			admission,
			consumeIpRateLimit: async () => {
				throw new Error('limiter store unavailable');
			},
		});

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 503 });
		expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull();
	});

	it('rejects with 503 and releases the lease when schema resolution throws at establishment', async () => {
		const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 100 } });

		harness = await createHarness({
			admission,
			getSchema: async () => {
				throw new Error('schema unavailable');
			},
		});

		const result = await harness.connect();
		expect(result).toMatchObject({ kind: 'reject', status: 503 });
		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
	});
});

describe('strict auth deadline and disconnect', () => {
	it('closes on the deadline while a lookup is pending and holds the slot until settlement', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const db = deferredDatabase();
		harness = await createHarness({ authMode: 'strict', authTimeoutMs: 50, admission, database: db.database });

		const result = await harness.connect({ headers: { authorization: 'Bearer static-token' } });
		expect(result).toMatchObject({ kind: 'reject', status: 401 });

		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();
		db.resolve();
		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
	});

	it('closes the owner without a status write on a mid-lookup raw-socket disconnect', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const db = deferredDatabase();
		harness = await createHarness({ authMode: 'strict', authTimeoutMs: 10_000, admission, database: db.database });

		const rawSocket = harness.nextRawSocket();

		const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/websocket`, {
			headers: { authorization: 'Bearer static-token' },
		});

		harness.sockets.push(ws);
		ws.on('error', () => undefined);

		const socket = await rawSocket;
		await db.called;
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();

		const destroyed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		ws.terminate();
		await destroyed;

		db.resolve();
		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
	});
});

describe('establishment during schema resolution', () => {
	it('releases the lease and emits no connect when the peer disconnects during schema resolution', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const schema = deferredSchema();
		harness = await createHarness({ admission, getSchema: schema.getSchema });

		const rawSocket = harness.nextRawSocket();
		const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/websocket`);
		harness.sockets.push(ws);
		ws.on('error', () => undefined);

		const socket = await rawSocket;
		await schema.called;
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();

		const destroyed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		ws.terminate();
		await destroyed;
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();

		schema.resolve();
		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
		expect(callsFor('websocket.connect')).toHaveLength(0);
	});

	it('destroys the raw socket at once on a disconnect, without waiting for a hanging schema', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const schema = deferredSchema();
		const local = await createHarness({ admission, getSchema: schema.getSchema });

		try {
			const rawSocket = local.nextRawSocket();
			const ws = new WebSocket(`ws://127.0.0.1:${local.port}/websocket`);
			local.sockets.push(ws);
			ws.on('error', () => undefined);

			const socket = await rawSocket;
			await schema.called;

			const destroyed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
			ws.terminate();
			await destroyed;
		} finally {
			await local.teardown();
		}
	});

	it('rejects a strict upgrade with 401 when the token expires during schema resolution', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const schema = deferredSchema();
		const token = signUser('alice', { expiresIn: '100s' });
		harness = await createHarness({ authMode: 'strict', authTimeoutMs: 10_000, getSchema: schema.getSchema });

		const connecting = harness.connect({ headers: { authorization: `Bearer ${token}` } });
		await schema.called;
		vi.advanceTimersByTime(200_000);
		schema.resolve();

		expect(await connecting).toMatchObject({ kind: 'reject', status: 401 });
		expect(callsFor('websocket.connect')).toHaveLength(0);
	});
});

describe('token-expiry timer', () => {
	it('re-arms beyond the timer ceiling, does not fire early, and closes a strict connection on expiry', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const token = signUser('alice', { expiresIn: '30d' });
		harness = await createHarness({ authMode: 'strict' });

		const opened = await harness.connect({ headers: { authorization: `Bearer ${token}` } });
		expect(opened.kind).toBe('open');

		const closed = new Promise<void>((resolve) => {
			if (opened.kind === 'open') opened.ws.on('close', () => resolve());
		});

		vi.advanceTimersByTime(TIMER_MAX_MS - 1000);
		expect(opened.kind === 'open' && opened.ws.readyState).toBe(WebSocket.OPEN);

		vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
		await closed;
	});

	it('fires at exactly the expiry for a sub-ceiling token', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const token = signUser('alice', { expiresIn: '3600s' });
		harness = await createHarness({ authMode: 'strict' });

		const opened = await harness.connect({ headers: { authorization: `Bearer ${token}` } });
		expect(opened.kind).toBe('open');

		const closed = new Promise<void>((resolve) => {
			if (opened.kind === 'open') opened.ws.on('close', () => resolve());
		});

		vi.advanceTimersByTime(3_600_000 - 1);
		expect(opened.kind === 'open' && opened.ws.readyState).toBe(WebSocket.OPEN);

		vi.advanceTimersByTime(1);
		await closed;
	});

	it('invokes onExpiry before closing a strict connection, in that order', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const order: string[] = [];
		harness = await createHarness({ authMode: 'strict', controllerClass: TestController });
		(harness.controller as TestController).expiryBehavior = () => order.push('onExpiry');

		const token = signUser('alice', { expiresIn: '100s' });
		const opened = await harness.connect({ headers: { authorization: `Bearer ${token}` } });
		expect(opened.kind).toBe('open');

		const closed = new Promise<void>((resolve) => {
			if (opened.kind === 'open')
				opened.ws.on('close', () => {
					order.push('close');
					resolve();
				});
		});

		vi.advanceTimersByTime(100_000);
		await closed;
		expect(order).toEqual(['onExpiry', 'close']);
	});

	it('still closes a strict connection when onExpiry throws', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		harness = await createHarness({ authMode: 'strict', controllerClass: TestController });

		(harness.controller as TestController).expiryBehavior = () => {
			throw new Error('enqueue failed');
		};

		const token = signUser('alice', { expiresIn: '100s' });
		const opened = await harness.connect({ headers: { authorization: `Bearer ${token}` } });
		expect(opened.kind).toBe('open');

		const closed = new Promise<void>((resolve) => {
			if (opened.kind === 'open') opened.ws.on('close', () => resolve());
		});

		vi.advanceTimersByTime(100_000);
		await closed;
	});

	it('clears the expiry timer so onExpiry never fires after a close before expiry', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		let fired = 0;
		harness = await createHarness({ authMode: 'strict', controllerClass: TestController });

		(harness.controller as TestController).expiryBehavior = () => {
			fired++;
		};

		const token = signUser('alice', { expiresIn: '100s' });
		const opened = await harness.connect({ headers: { authorization: `Bearer ${token}` } });
		expect(opened.kind).toBe('open');

		const closed = new Promise<void>((resolve) => {
			if (opened.kind === 'open') opened.ws.on('close', () => resolve());
		});

		if (opened.kind === 'open') opened.ws.close();
		await closed;
		await flush();

		vi.advanceTimersByTime(200_000);
		expect(fired).toBe(0);
	});
});

async function openClient(options?: HarnessOptions): Promise<{ ws: WebSocket; frames: Record<string, any>[] }> {
	harness = await createHarness(options);
	const opened = await harness.connect();
	if (opened.kind !== 'open') throw new Error('expected an open connection');
	return { ws: opened.ws, frames: collect(opened.ws) };
}

describe('REST message path', () => {
	it('answers a malformed frame with INVALID_PAYLOAD and stays open', async () => {
		const { ws, frames } = await openClient();

		ws.send('not json');
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(frames[0]).toMatchObject({ status: 'error', error: { code: 'INVALID_PAYLOAD' } });
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it('answers an unregistered type with UNSUPPORTED_MESSAGE_TYPE, carrying the uid', async () => {
		const { ws, frames } = await openClient({ controllerClass: TestController });

		sendJson(ws, { type: 'nope', uid: 5 });
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(frames[0]).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_MESSAGE_TYPE' }, uid: 5 });
	});

	it('runs commands serially, the second only after the first resolves', async () => {
		const { ws } = await openClient({ controllerClass: TestController });
		const controller = harness!.controller as TestController;
		const gate = deferred<void>();
		controller.commandGate = () => gate.promise;

		sendJson(ws, { type: 'test', uid: 1 });
		sendJson(ws, { type: 'test', uid: 2 });

		await vi.waitFor(() => expect(controller.commandLog).toEqual([1]));
		await flush();
		expect(controller.commandLog).toEqual([1]);

		gate.resolve();
		await vi.waitFor(() => expect(controller.commandLog).toEqual([1, 2]));
	});

	it('emits websocket.message after a successful command', async () => {
		const { ws } = await openClient({ controllerClass: TestController });

		sendJson(ws, { type: 'test', uid: 8 });
		await vi.waitFor(() => expect(callsFor('websocket.message')).toHaveLength(1));
		const meta = callsFor('websocket.message')[0]![1] as { message: { type: string; uid: number } };
		expect(meta.message).toMatchObject({ type: 'test', uid: 8 });
	});

	it('answers a handler rejection with INTERNAL_ERROR and no raw error', async () => {
		const { ws, frames } = await openClient({ controllerClass: TestController });
		(harness!.controller as TestController).handlerError = new Error('handler boom');

		sendJson(ws, { type: 'test', uid: 6 });
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(frames[0]).toMatchObject({ status: 'error', error: { code: 'INTERNAL_ERROR' } });
		expect(frames[0]!['error'].message).not.toContain('handler boom');
	});

	it('charges the shared limiter per message and answers REQUESTS_EXCEEDED without closing', async () => {
		let budget = 1;

		const { ws, frames } = await openClient({
			controllerClass: TestController,
			consumeIpRateLimit: async () => (budget-- > 0 ? { allowed: true } : { allowed: false, retryAfterMs: 1000 }),
		});

		sendJson(ws, { type: 'test', uid: 9 });
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(frames[0]).toMatchObject({ status: 'error', error: { code: 'REQUESTS_EXCEEDED' } });
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it('rejects the overflowing frame with TOO_MANY_PENDING and closes 1013', async () => {
		const { ws, frames } = await openClient({ controllerClass: TestController });
		const controller = harness!.controller as TestController;
		const gate = deferred<void>();
		controller.commandGate = () => gate.promise;

		const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
		for (let i = 0; i < PENDING_COMMAND_LIMIT + 2; i++) sendJson(ws, { type: 'test', uid: i });

		await vi.waitFor(() => expect(frames.some((f) => f['error']?.code === 'TOO_MANY_PENDING')).toBe(true));
		expect(await closed).toBe(1013);
		gate.resolve();
	});

	it('keeps the admission slot counted after close until a stalled handler settles', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const { ws } = await openClient({ controllerClass: TestController, admission });
		const controller = harness!.controller as TestController;
		const gate = deferred<void>();
		controller.commandGate = () => gate.promise;

		sendJson(ws, { type: 'test', uid: 1 });
		await vi.waitFor(() => expect(controller.commandLog).toEqual([1]));

		const clientClosed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
		ws.close();
		await clientClosed;
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();

		gate.resolve();
		await vi.waitFor(() => expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull());
	});

	it('discards waiting commands on close so no waiter runs', async () => {
		const { ws } = await openClient({ controllerClass: TestController });
		const controller = harness!.controller as TestController;
		const gate = deferred<void>();
		controller.commandGate = () => gate.promise;

		sendJson(ws, { type: 'test', uid: 1 });
		sendJson(ws, { type: 'test', uid: 2 });
		sendJson(ws, { type: 'test', uid: 3 });
		await vi.waitFor(() => expect(controller.commandLog).toEqual([1]));

		const clientClosed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
		ws.close();
		await clientClosed;

		gate.resolve();
		await flush();
		expect(controller.commandLog).toEqual([1]);
	});
});

describe('handshake auth-message path', () => {
	it('authenticates the first message, emits only connect, and sends the auth-success frame', async () => {
		const { ws, frames } = await openClient({ authMode: 'handshake' });

		sendJson(ws, { type: 'auth', access_token: signUser('alice'), uid: 1 });
		await vi.waitFor(() => expect(callsFor('websocket.connect')).toHaveLength(1));

		const context = callsFor('websocket.connect')[0]![2] as { schema: unknown; accountability: { user: string } };
		expect(context.accountability.user).toBe('alice');
		expect(context.schema).toBe(SCHEMA);
		expect(callsFor('websocket.auth.success')).toHaveLength(0);

		await vi.waitFor(() => expect(frames.some((f) => f['type'] === 'auth' && f['status'] === 'ok')).toBe(true));
	});

	it('closes on a non-auth first message with no connect or auth event', async () => {
		const { ws } = await openClient({ authMode: 'handshake' });
		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

		sendJson(ws, { type: 'subscribe', uid: 1 });
		await closed;
		expect(callsFor('websocket.connect')).toHaveLength(0);
		expect(callsFor('websocket.auth.failure')).toHaveLength(0);
	});

	it('closes on an invalid token first message with AUTH_FAILED', async () => {
		const { ws, frames } = await openClient({ authMode: 'handshake' });
		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

		sendJson(ws, { type: 'auth', access_token: signInvalid() });
		await closed;
		expect(callsFor('websocket.connect')).toHaveLength(0);
		expect(frames.some((f) => f['error']?.code === 'AUTH_FAILED')).toBe(true);
	});

	it('closes on a userless (share) token first message, matching strict', async () => {
		const { ws } = await openClient({ authMode: 'handshake' });
		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

		sendJson(ws, { type: 'auth', access_token: signShare() });
		await closed;
		expect(callsFor('websocket.connect')).toHaveLength(0);
	});

	it('suppresses connect when the peer disconnects during post-auth schema resolution', async () => {
		const schema = deferredSchema();

		const { ws } = await openClient({
			authMode: 'handshake',
			getSchema: schema.getSchema,
			controllerClass: TestController,
		});

		const controller = harness!.controller as TestController;

		sendJson(ws, { type: 'auth', access_token: signUser('alice') });
		await schema.called;

		ws.terminate();
		await vi.waitFor(() => expect(controller.clientCount).toBe(0));
		schema.resolve();
		await flush();

		expect(callsFor('websocket.connect')).toHaveLength(0);
	});
});

describe('public auth-message path', () => {
	it('elevates a public connection, emitting websocket.auth.success', async () => {
		const { ws, frames } = await openClient({ authMode: 'public' });

		sendJson(ws, { type: 'auth', access_token: signUser('alice'), uid: 2 });
		await vi.waitFor(() => expect(callsFor('websocket.auth.success')).toHaveLength(1));

		const context = callsFor('websocket.auth.success')[0]![2] as { accountability: { user: string } };
		expect(context.accountability.user).toBe('alice');
		await vi.waitFor(() => expect(frames.some((f) => f['type'] === 'auth' && f['status'] === 'ok')).toBe(true));
	});

	it('reverts a failed reauthentication to anonymous, emitting auth.failure and staying open', async () => {
		const { ws } = await openClient({ authMode: 'public' });

		sendJson(ws, { type: 'auth', access_token: signUser('alice') });
		await vi.waitFor(() => expect(callsFor('websocket.auth.success')).toHaveLength(1));

		sendJson(ws, { type: 'auth', access_token: signInvalid() });
		await vi.waitFor(() => expect(callsFor('websocket.auth.failure')).toHaveLength(1));

		const context = callsFor('websocket.auth.failure')[0]![2] as { accountability: { user: string | null } };
		expect(context.accountability.user).toBeNull();
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it('closes on a different-user reauthentication', async () => {
		const { ws } = await openClient({ authMode: 'public' });
		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

		sendJson(ws, { type: 'auth', access_token: signUser('alice') });
		await vi.waitFor(() => expect(callsFor('websocket.auth.success')).toHaveLength(1));

		sendJson(ws, { type: 'auth', access_token: signUser('bob') });
		await closed;
	});

	it('closes with 1013 when the user bucket is full during public elevation', async () => {
		const admission = new Admission({ process: 100, ip: 100, user: 1, transports: { rest: 100 } });
		admission.reserve('rest', '9.9.9.9')!.transitionToUser('alice');
		const { ws } = await openClient({ authMode: 'public', admission });
		const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

		sendJson(ws, { type: 'auth', access_token: signUser('alice') });
		expect(await closed).toBe(1013);
	});

	it('sends TOKEN_EXPIRED before closing a strict connection on expiry', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const token = signUser('alice', { expiresIn: '100s' });
		harness = await createHarness({ authMode: 'strict' });
		const opened = await harness.connect({ headers: { authorization: `Bearer ${token}` } });
		if (opened.kind !== 'open') throw new Error('expected an open connection');
		const frames = collect(opened.ws);
		const closed = new Promise<void>((resolve) => opened.ws.on('close', () => resolve()));

		vi.advanceTimersByTime(100_000);
		await closed;
		expect(frames.some((f) => f['error']?.code === 'TOKEN_EXPIRED')).toBe(true);
	});
});

describe('commit-6 review additions', () => {
	it('discards a queued command when a failed reauthentication initiates close', async () => {
		const db = deferredDatabase();
		harness = await createHarness({ authMode: 'strict', database: db.database, controllerClass: TestController });
		const controller = harness.controller as TestController;
		const opened = await harness.connect({ headers: { authorization: `Bearer ${signUser('alice')}` } });
		if (opened.kind !== 'open') throw new Error('expected an open connection');

		sendJson(opened.ws, { type: 'auth', access_token: 'static-bad-token' });
		await db.called;
		sendJson(opened.ws, { type: 'test', uid: 1 });
		await flush();

		db.resolve();
		await flush();
		await flush();

		expect(controller.commandLog).toEqual([]);
	});

	it('fails the handshake on first-frame limiter exhaustion so a later permitted frame cannot establish', async () => {
		let call = 0;

		const { ws } = await openClient({
			authMode: 'handshake',
			authTimeoutMs: 10_000,
			consumeIpRateLimit: async () => {
				call++;
				return call === 2 ? { allowed: false, retryAfterMs: 1000 } : { allowed: true };
			},
		});

		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

		sendJson(ws, { type: 'auth', access_token: signUser('alice') });
		sendJson(ws, { type: 'auth', access_token: signUser('alice') });
		await closed;
		expect(callsFor('websocket.connect')).toHaveLength(0);
		expect(callsFor('websocket.auth.failure')).toHaveLength(0);
	});

	it('supersedes a public reauthentication that times out and discards a late success', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const db = deferredUserDatabase('alice');

		const { ws } = await openClient({
			authMode: 'public',
			authTimeoutMs: 5000,
			database: db.database,
			controllerClass: TestController,
		});

		sendJson(ws, { type: 'auth', access_token: 'static-token' });
		await db.called;
		vi.advanceTimersByTime(6000);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		db.resolve();
		await flush();
		await flush();
		expect(callsFor('websocket.auth.success')).toHaveLength(0);

		sendJson(ws, { type: 'test', uid: 9 });
		await waitFrames(() => callsFor('websocket.message').length >= 1);
		const context = callsFor('websocket.message')[0]![2] as { accountability: { user: string | null } };
		expect(context.accountability.user).toBeNull();
	});

	it('invalidates an in-flight authentication when stop is called, holding admission until finalization', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { rest: 100 } });
		const db = deferredUserDatabase('alice');

		const { ws } = await openClient({
			authMode: 'public',
			authTimeoutMs: 10_000,
			admission,
			database: db.database,
			controllerClass: TestController,
		});

		const controller = harness!.controller as TestController;
		const serverWs = (callsFor('websocket.connect')[0]![1] as { client: SocketClient }).client;
		ws.pause();

		sendJson(ws, { type: 'auth', access_token: 'static-token' });
		await db.called;

		controller.stopClient(serverWs);
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();

		db.resolve();
		await flush();
		await flush();

		expect(serverWs.auth.accountability.user).toBeNull();
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();
	});

	it('escalates an already-stopping client to forced termination', async () => {
		const { ws } = await openClient({ authMode: 'public', controllerClass: TestController });
		const controller = harness!.controller as TestController;
		const serverWs = (callsFor('websocket.connect')[0]![1] as { client: SocketClient }).client;
		void ws;

		controller.stopClient(serverWs);
		expect(serverWs.stopping).toBe(true);

		const terminateSpy = vi.spyOn(serverWs, 'terminate');
		controller.stopClient(serverWs, { terminate: true });
		expect(terminateSpy).toHaveBeenCalled();
	});

	it('rejects a command whose full-authority filter changed the message type', async () => {
		const { ws, frames } = await openClient({ controllerClass: TestController });
		const controller = harness!.controller as TestController;
		const filter = (message: Record<string, unknown>) => ({ ...message, type: 'rerouted' });
		emitter.onFilter('websocket.message', filter);

		try {
			sendJson(ws, { type: 'test', uid: 7 });
			await vi.waitFor(() => expect(frames.some((f) => f['error']?.code === 'INVALID_PAYLOAD')).toBe(true));
			expect(controller.commandLog).toEqual([]);
		} finally {
			emitter.offFilter('websocket.message', filter);
		}
	});

	it('keys the message limiter on the immutable connection IP, not mutable accountability', async () => {
		const ipCalls: string[] = [];

		const tamper = (meta: { client: SocketClient }) => {
			(meta.client.auth.accountability as { ip: string }).ip = 'tampered';
		};

		emitter.onAction('websocket.connect', tamper);

		try {
			const { ws } = await openClient({
				controllerClass: TestController,
				consumeIpRateLimit: async (ip) => {
					ipCalls.push(ip);
					return { allowed: true };
				},
			});

			sendJson(ws, { type: 'test', uid: 1 });
			await vi.waitFor(() => expect((harness!.controller as TestController).commandLog).toEqual([1]));
			expect(ipCalls.length).toBeGreaterThan(0);
			expect(ipCalls).not.toContain('tampered');
		} finally {
			emitter.offAction('websocket.connect', tamper);
		}
	});

	it('rejects a userless (share) token on public elevation, reverting and staying open', async () => {
		const { ws, frames } = await openClient({ authMode: 'public' });

		sendJson(ws, { type: 'auth', access_token: signShare() });
		await vi.waitFor(() => expect(frames.some((f) => f['error']?.code === 'AUTH_FAILED')).toBe(true));
		await vi.waitFor(() => expect(callsFor('websocket.auth.failure')).toHaveLength(1));
		expect(callsFor('websocket.auth.success')).toHaveLength(0);
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it('replaces the expiry timer on a successful reauthentication', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		const { ws, frames } = await openClient({ authMode: 'public' });
		const okCount = () => frames.filter((f) => f['type'] === 'auth' && f['status'] === 'ok').length;
		const expiredSeen = () => frames.some((f) => f['error']?.code === 'TOKEN_EXPIRED');

		sendJson(ws, { type: 'auth', access_token: signUser('alice', { expiresIn: '100s' }) });
		await waitFrames(() => okCount() >= 1);

		sendJson(ws, { type: 'auth', access_token: signUser('alice', { expiresIn: '300s' }) });
		await waitFrames(() => okCount() >= 2);

		vi.advanceTimersByTime(150_000);
		await flush();
		expect(expiredSeen()).toBe(false);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		vi.advanceTimersByTime(200_000);
		await waitFrames(expiredSeen);
		expect(expiredSeen()).toBe(true);
	});
});

describe('commit-7 drain additions', () => {
	it('skips the handler and the success action when the refresh does not proceed', async () => {
		const { ws } = await openClient({ controllerClass: TestController });
		const controller = harness!.controller as TestController;
		const reached = deferred<void>();

		controller.refreshGate = async () => {
			reached.resolve();
			return false;
		};

		sendJson(ws, { type: 'test', uid: 1 });
		await reached.promise;
		await flush();

		expect(controller.commandLog).toEqual([]);
		expect(callsFor('websocket.message')).toHaveLength(0);
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it('gives the handler the schema fetched at command time, not the connect snapshot', async () => {
		const connectSchema = { collections: {}, relations: [] } as unknown as SchemaOverview;
		const commandSchema = { collections: {}, relations: [] } as unknown as SchemaOverview;
		let calls = 0;
		const getSchema = async () => (calls++ === 0 ? connectSchema : commandSchema);

		const { ws } = await openClient({ controllerClass: TestController, getSchema });
		const controller = harness!.controller as TestController;
		const serverWs = (callsFor('websocket.connect')[0]![1] as { client: SocketClient }).client;

		sendJson(ws, { type: 'test', uid: 1 });
		await vi.waitFor(() => expect(controller.commandLog).toEqual([1]));

		expect(controller.lastContext?.schema).toBe(commandSchema);
		expect(serverWs.schema).toBe(connectSchema);
	});

	it('sends a handler-thrown WebSocketException with its own envelope and fires no success action', async () => {
		const { ws, frames } = await openClient({ controllerClass: TestController });
		(harness!.controller as TestController).handlerError = new WebSocketException('items', 'FORBIDDEN', 3);

		sendJson(ws, { type: 'test', uid: 3 });
		await vi.waitFor(() => expect(frames).toHaveLength(1));

		expect(frames[0]).toMatchObject({
			type: 'items',
			status: 'error',
			uid: 3,
			error: { code: 'FORBIDDEN', message: 'The request could not be completed.' },
		});

		expect(callsFor('websocket.message')).toHaveLength(0);
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});
});

describe('commit-8a subscription wiring', () => {
	it('answers a subscribe to an unknown collection with a subscribe INVALID_COLLECTION frame and stays open', async () => {
		const { ws, frames } = await openClient({ controllerClass: TestController });

		sendJson(ws, { type: 'subscribe', collection: 'articles', uid: 5 });
		await vi.waitFor(() => expect(frames).toHaveLength(1));

		expect(frames[0]).toMatchObject({
			type: 'subscribe',
			status: 'error',
			uid: '5',
			error: { code: 'INVALID_COLLECTION' },
		});

		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it('removes a connection active subscriptions on close through the production finalizeClient', async () => {
		const { ws } = await openClient({ controllerClass: TestController });
		const registry = harness!.subscriptions;
		const serverWs = (callsFor('websocket.connect')[0]![1] as { client: SocketClient }).client;

		registry.reserve({ client: serverWs, collection: 'articles', query: {} })!.activate();
		registry.reserve({ client: serverWs, collection: 'posts', query: {} })!.activate();
		expect(registry.getSubscribedOwners()).toContain(serverWs);

		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
		ws.close();
		await closed;

		await vi.waitFor(() => expect(registry.getSubscribedOwners()).toHaveLength(0));
	});
});
