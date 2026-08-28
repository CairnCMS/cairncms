import type { SchemaOverview } from '@cairncms/types';
import express from 'express';
import { GraphQLBoolean, GraphQLEnumType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { getEnv } from '../../env.js';
import type { RateLimitConsumption } from '../../middleware/rate-limiter-ip.js';
import { Admission } from '../admission.js';
import { PENDING_COMMAND_LIMIT } from '../config.js';
import type { WebSocketMessage } from '../messages.js';
import { SubscriptionRegistry } from '../subscriptions.js';
import type { SocketClient } from './base.js';

const REDACTED_MESSAGE = 'An unexpected error occurred.';

let onStreamReturn: (() => Promise<void>) | null = null;
let releaseFinalizer: (() => void) | null = null;

function pendingStream(): AsyncIterableIterator<unknown> {
	let yielded = false;
	let settle: ((result: IteratorResult<unknown>) => void) | null = null;

	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			if (!yielded) {
				yielded = true;
				return Promise.resolve({ value: true, done: false });
			}

			return new Promise<IteratorResult<unknown>>((resolve) => {
				settle = resolve;
			});
		},
		async return() {
			settle?.({ value: undefined, done: true });
			settle = null;
			if (onStreamReturn !== null) await onStreamReturn();
			return { value: undefined, done: true };
		},
	};
}

const EventEnum = new GraphQLEnumType({
	name: 'EventEnum',
	values: { create: {}, update: {}, delete: {} },
});

const TEST_SCHEMA = new GraphQLSchema({
	query: new GraphQLObjectType({ name: 'Query', fields: { ok: { type: GraphQLBoolean } } }),
	subscription: new GraphQLObjectType({
		name: 'Subscription',
		fields: {
			articles_mutated: {
				type: GraphQLBoolean,
				args: { event: { type: EventEnum } },
				subscribe: () => pendingStream(),
			},
		},
	}),
});

vi.mock('../../services/graphql/index.js', () => ({
	GraphQLService: class {
		getSchema(): GraphQLSchema {
			return TEST_SCHEMA;
		}
	},
}));

vi.mock('../../utils/get-permissions.js', () => ({
	default: async () => [],
	getPermissions: async () => [],
}));

const { GraphQLController } = await import('./graphql.js');

const SCHEMA = { collections: {}, relations: [] } as unknown as SchemaOverview;

class GatedGraphQLController extends GraphQLController {
	public setupGate: (() => Promise<void>) | null = null;
	public readonly gateEntered = deferred<void>();
	public readonly completeRouted = deferred<void>();
	public readonly reuseEntering = deferred<void>();
	public pingsReceived = 0;
	private subscribeCount = 0;

	protected override createClient(ws: SocketClient, auth: SocketClient['auth'], ip: string): SocketClient {
		const client = super.createClient(ws, auth, ip);

		ws.on('message', (data: RawData) => {
			try {
				if ((JSON.parse(data.toString()) as { type?: string }).type === 'ping') this.pingsReceived++;
			} catch {
				// Non-JSON frames are irrelevant to the ping accounting.
			}
		});

		return client;
	}

	protected override async refreshBeforeCommand(client: SocketClient, schema: SchemaOverview): Promise<boolean> {
		const gate = this.setupGate;

		if (gate !== null) {
			this.setupGate = null;
			this.gateEntered.resolve();
			await gate();
		}

		return super.refreshBeforeCommand(client, schema);
	}

	protected override async routeMessage(client: SocketClient, message: WebSocketMessage): Promise<void> {
		const type = (message as { type?: string }).type;

		if (type === 'subscribe' && ++this.subscribeCount === 2) this.reuseEntering.resolve();

		await super.routeMessage(client, message);

		if (type === 'complete') this.completeRouted.resolve();
	}
}

const env = () => getEnv() as Record<string, unknown>;

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

function signAdmin(user: string): string {
	return jwt.sign({ id: user, role: 'role-1', app_access: true, admin_access: true }, secret(), {
		issuer: 'cairncms',
		expiresIn: '1h',
	});
}

function signInvalid(): string {
	return jwt.sign({ id: 'alice', role: 'role-1', app_access: true, admin_access: false }, 'wrong-secret', {
		issuer: 'cairncms',
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;

	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});

	return { promise, resolve };
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

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface HarnessOptions {
	authMode?: 'public' | 'handshake' | 'strict';
	authTimeoutMs?: number;
	heartbeatPeriodMs?: number;
	admission?: Admission;
	database?: Knex;
	consumeIpRateLimit?: (ip: string) => Promise<RateLimitConsumption>;
	controllerClass?: typeof GraphQLController;
}

interface Harness {
	controller: InstanceType<typeof GraphQLController>;
	database: Knex;
	getSchema: ReturnType<typeof vi.fn>;
	server: Server;
	port: number;
	sockets: WebSocket[];
	teardown: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const admission =
		options.admission ?? new Admission({ process: 100, ip: 100, user: 100, transports: { graphql: 100 } });

	const database = options.database ?? ({} as Knex);
	const getSchema = vi.fn(async (_options?: { database?: Knex }) => SCHEMA);

	const ControllerClass = options.controllerClass ?? GraphQLController;

	const controller = new ControllerClass({
		transport: 'graphql',
		path: '/graphql',
		authMode: options.authMode ?? 'public',
		authTimeoutMs: options.authTimeoutMs ?? 10_000,
		maxPayload: 1_048_576,
		heartbeatPeriodMs: options.heartbeatPeriodMs ?? 10_000_000,
		admission,
		isOriginAllowed: () => true,
		consumeIpRateLimit: options.consumeIpRateLimit ?? (async () => ({ allowed: true })),
		consumeGlobalRateLimit: async () => ({ allowed: true }),
		app: express(),
		database,
		getSchema,
		subscriptions: new SubscriptionRegistry(),
	});

	const server = createServer();
	server.on('upgrade', controller.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as AddressInfo).port;

	const sockets: WebSocket[] = [];

	const teardown = async () => {
		for (const socket of sockets) socket.terminate();
		await controller.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { controller, database, getSchema, server, port, sockets, teardown };
}

interface Connected {
	ws: WebSocket;
	frames: Record<string, any>[];
	closed: Promise<{ code: number; reason: string }>;
}

function connect(
	harness: Harness,
	headers?: Record<string, string>,
	wsOptions?: { autoPong?: boolean }
): Promise<Connected> {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/graphql`, 'graphql-transport-ws', { headers, ...wsOptions });
	harness.sockets.push(ws);

	const frames: Record<string, any>[] = [];
	ws.on('message', (data) => frames.push(JSON.parse(data.toString())));

	const closed = new Promise<{ code: number; reason: string }>((resolve) =>
		ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
	);

	return new Promise((resolve, reject) => {
		ws.on('open', () => resolve({ ws, frames, closed }));
		ws.on('error', reject);
		ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
	});
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
	ws.send(JSON.stringify(message));
}

function hasType(frames: Record<string, any>[], type: string): boolean {
	return frames.some((frame) => frame['type'] === type);
}

function waitForAck(frames: Record<string, any>[]): Promise<void> {
	return vi.waitFor(() => expect(hasType(frames, 'connection_ack')).toBe(true));
}

function waitForId(frames: Record<string, any>[], type: string, id: string): Promise<void> {
	return vi.waitFor(() => expect(frames.some((frame) => frame['type'] === type && frame['id'] === id)).toBe(true));
}

let harness: Harness | null = null;

afterEach(async () => {
	releaseFinalizer?.();
	releaseFinalizer = null;
	onStreamReturn = null;
	if (harness) await harness.teardown();
	harness = null;
	vi.useRealTimers();
});

describe('GraphQL connection_init authentication', () => {
	it('public acknowledges an anonymous init with no token', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);
	});

	it('public acknowledges an anonymous init with a null payload', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init', payload: null });
		await waitForAck(frames);
	});

	it('public elevates and acknowledges a valid-token init', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: signUser('alice') } });
		await waitForAck(frames);
	});

	it('public closes 4403 on an invalid-token init', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, closed } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: signInvalid() } });
		expect((await closed).code).toBe(4403);
	});

	it('handshake acknowledges a valid-token init', async () => {
		harness = await createHarness({ authMode: 'handshake' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: signUser('alice') } });
		await waitForAck(frames);
	});

	it('handshake closes 4403 on a token-less init', async () => {
		harness = await createHarness({ authMode: 'handshake' });
		const { ws, closed } = await connect(harness);
		send(ws, { type: 'connection_init' });
		expect((await closed).code).toBe(4403);
	});

	it('strict acknowledges a token-less init after a Bearer upgrade', async () => {
		harness = await createHarness({ authMode: 'strict' });
		const { ws, frames } = await connect(harness, { authorization: `Bearer ${signUser('alice')}` });
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);
	});

	it('strict closes 4403 on a token-bearing init', async () => {
		harness = await createHarness({ authMode: 'strict' });
		const { ws, closed } = await connect(harness, { authorization: `Bearer ${signUser('alice')}` });
		send(ws, { type: 'connection_init', payload: { access_token: signUser('alice') } });
		expect((await closed).code).toBe(4403);
	});
});

describe('GraphQL connection_init lifecycle', () => {
	for (const authMode of ['public', 'handshake', 'strict'] as const) {
		it(`closes 4403 on malformed credentials in ${authMode} mode`, async () => {
			harness = await createHarness({ authMode });
			const headers = authMode === 'strict' ? { authorization: `Bearer ${signUser('alice')}` } : undefined;
			const { ws, closed } = await connect(harness, headers);
			send(ws, { type: 'connection_init', payload: { access_token: null } });
			expect((await closed).code).toBe(4403);
		});
	}

	for (const authMode of ['public', 'handshake', 'strict'] as const) {
		it(`closes and releases admission when a ${authMode} peer never initializes`, async () => {
			const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { graphql: 100 } });
			harness = await createHarness({ authMode, authTimeoutMs: 50, admission });
			const headers = authMode === 'strict' ? { authorization: `Bearer ${signUser('alice')}` } : undefined;
			await connect(harness, headers);
			expect(admission.reserve('graphql', '2.2.2.2')).toBeNull();
			await vi.waitFor(() => expect(admission.reserve('graphql', '2.2.2.2')).not.toBeNull());
		});
	}

	it('closes 4429 on a duplicate connection_init', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames, closed } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);
		send(ws, { type: 'connection_init' });
		expect((await closed).code).toBe(4429);
	});

	it('re-elevates and resubscribes on reconnect under a refreshed token', async () => {
		harness = await createHarness({ authMode: 'public' });
		const controller = harness.controller;

		const initial = signUser('alice', { jwtid: 'initial' });
		const refreshed = signUser('alice', { jwtid: 'refreshed' });
		expect(refreshed).not.toBe(initial);

		const first = await connect(harness);
		send(first.ws, { type: 'connection_init', payload: { access_token: initial } });
		await waitForAck(first.frames);
		first.ws.close();
		await first.closed;

		const second = await connect(harness);
		send(second.ws, { type: 'connection_init', payload: { access_token: refreshed } });
		await waitForAck(second.frames);

		await vi.waitFor(() => expect(controller.clientSnapshot().size).toBe(1));
		const client = [...controller.clientSnapshot()][0]!;
		expect(client.auth.accountability.user).toBe('alice');

		send(second.ws, { type: 'subscribe', id: 's2', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(second.frames, 'next', 's2');
	});

	for (const authMode of ['handshake', 'strict'] as const) {
		it(`closes a ${authMode} connection when the token expires`, async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
			vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

			const token = signUser('alice', { expiresIn: '3600s' });
			harness = await createHarness({ authMode });
			const headers = authMode === 'strict' ? { authorization: `Bearer ${token}` } : undefined;
			const { ws, closed } = await connect(harness, headers);

			const acked = new Promise<void>((resolve) => {
				ws.on('message', (data) => {
					if (JSON.parse(data.toString())['type'] === 'connection_ack') resolve();
				});
			});

			const init =
				authMode === 'strict'
					? { type: 'connection_init' }
					: { type: 'connection_init', payload: { access_token: token } };

			send(ws, init);
			await acked;

			vi.advanceTimersByTime(3_600_000);
			await closed;
		});
	}
});

describe('GraphQL protocol frame handling', () => {
	it('closes 4400 on a malformed frame without a REST envelope', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames, closed } = await connect(harness);
		ws.send('not json');
		expect((await closed).code).toBe(4400);
		expect(frames.every((frame) => frame['status'] !== 'error')).toBe(true);
	});

	it('closes 1013 on a rate-limited frame without a REST envelope', async () => {
		let calls = 0;

		harness = await createHarness({
			authMode: 'public',
			consumeIpRateLimit: async () => {
				calls += 1;
				return { allowed: calls <= 1 };
			},
		});

		const { ws, frames, closed } = await connect(harness);
		send(ws, { type: 'connection_init' });
		expect((await closed).code).toBe(1013);
		expect(frames.every((frame) => frame['status'] !== 'error')).toBe(true);
	});
});

describe('GraphQL onSubscribe gate', () => {
	let originalLimit: unknown;
	let originalIntrospection: unknown;

	beforeEach(() => {
		originalLimit = env()['GRAPHQL_QUERY_TOKEN_LIMIT'];
		originalIntrospection = env()['GRAPHQL_INTROSPECTION'];
	});

	afterEach(() => {
		env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = originalLimit;
		env()['GRAPHQL_INTROSPECTION'] = originalIntrospection;
	});

	it('rejects a non-subscription operation', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'q', payload: { query: '{ ok }' } });
		await waitForId(frames, 'error', 'q');
	});

	it('rejects an over-token-limit document at onSubscribe', async () => {
		env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 2;
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: signAdmin('root') } });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'big', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'error', 'big');
		const errFrame = frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'big');
		expect(JSON.stringify(errFrame)).toMatch(/token/i);
	});

	it('rejects an introspecting document at onSubscribe when introspection is disabled', async () => {
		env()['GRAPHQL_INTROSPECTION'] = false;
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: signAdmin('root') } });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'meta', payload: { query: 'query { __schema { queryType { name } } }' } });
		await waitForId(frames, 'error', 'meta');
		const errFrame = frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'meta');
		expect(JSON.stringify(errFrame)).toMatch(/introspection/i);
	});
});

describe('GraphQL error redaction', () => {
	it('redacts a server field name from a gate suggestion at onError for a non-admin', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'e1', payload: { query: 'subscription { articles_mutate }' } });
		await waitForId(frames, 'error', 'e1');
		const errFrame = frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'e1');
		expect(JSON.stringify(errFrame)).not.toContain('articles_mutated');
		expect(errFrame!['payload'][0]['message']).toBe(REDACTED_MESSAGE);
	});

	it('redacts a subscription variable value from a coercion error at onError', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: signAdmin('root') } });
		await waitForAck(frames);

		send(ws, {
			type: 'subscribe',
			id: 'v1',
			payload: {
				query: 'subscription ($access_token: EventEnum!) { articles_mutated(event: $access_token) }',
				variables: { access_token: 'seeded-variable-secret' },
			},
		});

		await waitForId(frames, 'error', 'v1');
		const errFrame = frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'v1');
		expect(JSON.stringify(errFrame)).not.toContain('seeded-variable-secret');
	});
});

describe('GraphQL subscribe', () => {
	it('does not block later frames while a subscription stays open', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'next', 'sub');

		send(ws, { type: 'complete', id: 'sub' });
		send(ws, { type: 'ping' });

		await vi.waitFor(() => expect(hasType(frames, 'pong')).toBe(true));
		expect(frames.some((frame) => frame['type'] === 'error' && frame['id'] === 'sub')).toBe(false);
	});

	it('resolves the subscription schema with the injected database', async () => {
		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		harness.getSchema.mockClear();

		send(ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'next', 'sub');

		expect(harness.getSchema).toHaveBeenCalledTimes(1);
		expect(harness.getSchema).toHaveBeenCalledWith({ database: harness.database });
	});

	it('refreshes permissions with the resolved schema before building the subscription', async () => {
		harness = await createHarness({ authMode: 'public' });

		const refresh = vi.spyOn(
			harness.controller as unknown as { refreshBeforeCommand: () => Promise<boolean> },
			'refreshBeforeCommand'
		);

		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'next', 'sub');

		expect(refresh).toHaveBeenCalledWith(expect.anything(), SCHEMA);
	});

	it('rejects the subscription and delivers nothing when permissions cannot be refreshed', async () => {
		harness = await createHarness({ authMode: 'public' });

		vi.spyOn(
			harness.controller as unknown as { refreshBeforeCommand: () => Promise<boolean> },
			'refreshBeforeCommand'
		).mockResolvedValue(false);

		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'error', 'sub');

		expect(frames.some((frame) => frame['type'] === 'next' && frame['id'] === 'sub')).toBe(false);
	});
});

describe('GraphQL resource safety', () => {
	it('closes cleanly and releases admission on an oversized duplicate subscription id', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { graphql: 100 } });
		harness = await createHarness({ authMode: 'public', admission });
		const { ws, frames, closed } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		const id = 'x'.repeat(200);
		send(ws, { type: 'subscribe', id, payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'next', id);
		send(ws, { type: 'subscribe', id, payload: { query: 'subscription { articles_mutated }' } });

		expect((await closed).code).toBe(4409);
		await vi.waitFor(() => expect(admission.reserve('graphql', '2.2.2.2')).not.toBeNull());
	});

	it('awaits an open subscription generator during shutdown', async () => {
		let finalized = false;

		const gate = new Promise<void>((resolve) => {
			releaseFinalizer = resolve;
		});

		onStreamReturn = async () => {
			await gate;
			finalized = true;
		};

		harness = await createHarness({ authMode: 'public' });
		const { ws, frames } = await connect(harness);
		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		send(ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { articles_mutated }' } });
		await waitForId(frames, 'next', 'sub');

		const terminated = harness.controller.terminate();
		let settled = false;

		void terminated.then(() => {
			settled = true;
		});

		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(finalized).toBe(false);

		releaseFinalizer!();
		releaseFinalizer = null;
		await terminated;
		expect(finalized).toBe(true);
	});

	it('awaits an in-flight connection_init auth lookup during shutdown', async () => {
		const db = deferredUserDatabase('alice');
		harness = await createHarness({ authMode: 'public', database: db.database });
		const { ws } = await connect(harness);
		send(ws, { type: 'connection_init', payload: { access_token: 'static-token' } });
		await db.called;

		let settled = false;

		const terminated = harness.controller.terminate().then(() => {
			settled = true;
		});

		await flush();
		await flush();
		expect(settled).toBe(false);

		db.resolve();
		await terminated;
		expect(settled).toBe(true);
	});
});

describe('GraphQL heartbeat', () => {
	it('closes a peer that stops answering pings and releases its admission', async () => {
		const admission = new Admission({ process: 1, ip: 100, user: 100, transports: { graphql: 100 } });
		harness = await createHarness({ authMode: 'public', heartbeatPeriodMs: 40, admission });

		const { ws, frames, closed } = await connect(harness, undefined, { autoPong: false });
		const pinged = new Promise<void>((resolve) => ws.on('ping', () => resolve()));

		send(ws, { type: 'connection_init' });
		await waitForAck(frames);

		expect(admission.reserve('graphql', '9.9.9.9')).toBeNull();

		await pinged;
		await closed;

		await vi.waitFor(() => expect(admission.reserve('graphql', '9.9.9.9')).not.toBeNull());

		await harness.controller.terminate();
	});
});

describe('GraphQL operation backpressure', () => {
	it('holds same-id backlog in the base queue, then closes 1013 with no item frame on overflow', async () => {
		harness = await createHarness({ authMode: 'public', controllerClass: GatedGraphQLController });
		const controller = harness.controller as GatedGraphQLController;

		const stall = deferred<void>();
		controller.setupGate = () => stall.promise;

		try {
			const { ws, frames, closed } = await connect(harness);
			send(ws, { type: 'connection_init' });
			await waitForAck(frames);

			send(ws, { type: 'subscribe', id: 'X', payload: { query: 'subscription { articles_mutated }' } });
			await controller.gateEntered.promise;

			send(ws, { type: 'complete', id: 'X' });
			await controller.completeRouted.promise;

			send(ws, { type: 'subscribe', id: 'X', payload: { query: 'subscription { articles_mutated }' } });
			await controller.reuseEntering.promise;

			for (let index = 0; index < PENDING_COMMAND_LIMIT; index++) send(ws, { type: 'ping' });
			await vi.waitFor(() => expect(controller.pingsReceived).toBe(PENDING_COMMAND_LIMIT));
			expect(ws.readyState).toBe(WebSocket.OPEN);

			send(ws, { type: 'ping' });
			expect((await closed).code).toBe(1013);
			expect(frames.some((frame) => frame['error']?.code === 'TOO_MANY_PENDING')).toBe(false);
		} finally {
			stall.resolve();
		}
	});
});
