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
import { TIMER_MAX_MS, type AuthMode } from '../config.js';
import type { SocketClient, SocketControllerOptions } from './base.js';
import { WebSocketController } from './rest.js';

class TestController extends WebSocketController {
	public expiryBehavior: () => void = () => undefined;

	protected override buildOnExpiry(_client: SocketClient): () => void {
		return () => this.expiryBehavior();
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
	controllerClass?: new (options: SocketControllerOptions) => WebSocketController;
}

interface Harness {
	admission: Admission;
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

let emitAction: ReturnType<typeof vi.spyOn>;

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const admission = options.admission ?? new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 100 } });

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

	return { admission, controller, server, port, sockets, nextRawSocket, connect, teardown };
}

function callsFor(event: string): unknown[][] {
	return emitAction.mock.calls.filter((call) => call[0] === event);
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

let harness: Harness | null = null;

beforeEach(() => {
	emitAction = vi.spyOn(emitter, 'emitAction');
});

afterEach(async () => {
	if (harness) await harness.teardown();
	harness = null;
	emitAction.mockRestore();
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
