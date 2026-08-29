import type { SchemaOverview } from '@cairncms/types';
import express from 'express';
import {
	getOperationAST,
	GraphQLBoolean,
	GraphQLEnumType,
	GraphQLID,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	parse,
	type GraphQLResolveInfo,
} from 'graphql';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { getEnv } from '../../env.js';
import { Admission } from '../../websocket/admission.js';
import { DispatchCoordinator } from '../../websocket/dispatch.js';
import type { WebSocketEvent } from '../../websocket/messages.js';
import { SubscriptionRegistry } from '../../websocket/subscriptions.js';

const READ_SECRET = 'top-secret-value';
const TEST_SECRET = 'realtime-test-secret';
const originalSecret = getEnv()['SECRET'];

let readImpl: (
	accountability: { user: string | null },
	event: WebSocketEvent,
	key: string
) => Record<string, unknown>[];

let readFields: unknown;
let readDeep: unknown;
let subscriptionDeep: unknown;
let readAccountability: { user: string | null } | null;
let stallWhen: ((subscription: { collection: string; item?: string }) => boolean) | null;
let stallGate: Promise<void>;
let permissionsError: Error | null;
let permissionsResult: Record<string, unknown>[];
let targetUnavailable: boolean;
let eligibilityCalls: number;
let getEventPayloadCalls: number;
let getQueryError: Error | null;
let getSchemaImpl: () => Promise<SchemaOverview>;

vi.mock('../../websocket/config.js', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	SUBSCRIPTIONS_PER_CONNECTION: 2,
}));

const loggedPayloads: string[] = [];

vi.mock('../../utils/error-log.js', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import('../../utils/error-log.js');

	return {
		...actual,
		logRedactedError: (
			_level: unknown,
			snapshot: Record<string, unknown>,
			sensitiveValues: ReadonlySet<string>,
			extraKeys?: ReadonlySet<string>
		) => {
			loggedPayloads.push(JSON.stringify(actual.redactLogPayload(snapshot, sensitiveValues, extraKeys)));
		},
	};
});

vi.mock('../../utils/get-permissions.js', () => ({
	getPermissions: async () => {
		if (permissionsError !== null) throw permissionsError;
		return permissionsResult;
	},
}));

vi.mock('../../websocket/target.js', () => ({
	resolveTargetService: () => (targetUnavailable ? null : {}),
}));

vi.mock('../../websocket/utils/removal.js', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import('../../websocket/utils/removal.js');

	return {
		...actual,
		isDeleteFeedEligible: (...args: Parameters<typeof actual.isDeleteFeedEligible>) => {
			eligibilityCalls++;
			return actual.isDeleteFeedEligible(...args);
		},
	};
});

vi.mock('../../websocket/utils/items.js', () => ({
	getEventPayload: async (service: unknown, subscription: any, accountability: any, _schema: unknown, event: any) => {
		getEventPayloadCalls++;
		readFields = subscription.query.fields;
		readDeep = subscription.query.deep;
		readAccountability = accountability;
		if (stallWhen !== null && stallWhen(subscription)) await stallGate;
		return { data: readImpl(accountability, event, subscription.item) };
	},
}));

const { createSubscriptionGenerator, parseFields, resolveSubscriptionTarget, Rendezvous } = await import(
	'./subscription.js'
);

const { GraphQLController } = await import('../../websocket/controllers/graphql.js');

const EventEnum = new GraphQLEnumType({
	name: 'EventEnum',
	values: { create: {}, update: {}, delete: {} },
});

function mutatedType(name: string, dataType: GraphQLObjectType): GraphQLObjectType {
	return new GraphQLObjectType({
		name,
		fields: {
			key: { type: GraphQLID },
			event: { type: EventEnum },
			data: { type: dataType },
		},
	});
}

const ArticleType = new GraphQLObjectType({
	name: 'articles',
	fields: {
		id: { type: GraphQLID },
		title: { type: GraphQLString },
		secret: {
			type: GraphQLString,
			resolve: (source: Record<string, unknown>, _args: unknown, _context: unknown, info: GraphQLResolveInfo) => {
				if (source['secret'] === 'boom') throw new Error(String(info.variableValues['token']));
				return source['secret'] ?? null;
			},
		},
	},
});

const PostType = new GraphQLObjectType({
	name: 'posts',
	fields: { id: { type: GraphQLID } },
});

const fieldService = {
	getQuery: () => {
		if (getQueryError !== null) throw getQueryError;
		return { fields: ['id', 'title'], ...(subscriptionDeep !== undefined && { deep: subscriptionDeep }) };
	},
	accountability: null,
} as unknown as Parameters<typeof createSubscriptionGenerator>[0];

const TEST_SCHEMA = new GraphQLSchema({
	query: new GraphQLObjectType({ name: 'Query', fields: { ok: { type: GraphQLBoolean } } }),
	subscription: new GraphQLObjectType({
		name: 'Subscription',
		fields: {
			articles_mutated: {
				type: mutatedType('articles_mutated', ArticleType),
				args: { event: { type: EventEnum }, token: { type: GraphQLString } },
				subscribe: createSubscriptionGenerator(fieldService, 'articles_mutated'),
			},
			posts_mutated: {
				type: mutatedType('posts_mutated', PostType),
				args: { event: { type: EventEnum } },
				subscribe: createSubscriptionGenerator(fieldService, 'posts_mutated'),
			},
		},
	}),
});

vi.mock('./index.js', () => ({
	GraphQLService: class {
		getSchema(): GraphQLSchema {
			return TEST_SCHEMA;
		}
	},
}));

function schemaCollection(name: string): Record<string, unknown> {
	return { collection: name, primary: 'id', fields: {} };
}

const SCHEMA = {
	collections: { articles: schemaCollection('articles'), posts: schemaCollection('posts') },
	relations: [],
} as unknown as SchemaOverview;

function secret(): string {
	return TEST_SECRET;
}

function signUser(user: string): string {
	return jwt.sign({ id: user, role: 'role-1', app_access: true, admin_access: false }, secret(), {
		issuer: 'cairncms',
		expiresIn: '1h',
	});
}

interface FakeMessenger {
	subscribe: (channel: string, handler: (message: Record<string, any>) => void) => void;
	unsubscribe: (channel: string, handler: (message: Record<string, any>) => void) => void;
	publish: (channel: string, message: Record<string, any>) => void;
}

function fakeMessenger(): FakeMessenger {
	const handlers = new Set<(message: Record<string, any>) => void>();

	return {
		subscribe: (_channel, handler) => void handlers.add(handler),
		unsubscribe: (_channel, handler) => void handlers.delete(handler),
		publish: (_channel, message) => {
			for (const handler of handlers) handler(message);
		},
	};
}

interface HarnessOptions {
	deliveryConcurrency?: number;
}

interface Harness {
	controller: InstanceType<typeof GraphQLController>;
	coordinator: DispatchCoordinator;
	registry: SubscriptionRegistry;
	messenger: FakeMessenger;
	port: number;
	sockets: WebSocket[];
	teardown: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { graphql: 100 } });
	const registry = new SubscriptionRegistry();
	const messenger = fakeMessenger();

	const controller = new GraphQLController({
		transport: 'graphql',
		path: '/graphql',
		authMode: 'public',
		authTimeoutMs: 10_000,
		maxPayload: 1_048_576,
		heartbeatPeriodMs: 10_000_000,
		admission,
		isOriginAllowed: () => true,
		consumeIpRateLimit: async () => ({ allowed: true }),
		consumeGlobalRateLimit: async () => ({ allowed: true }),
		app: express(),
		database: {} as Knex,
		getSchema: () => getSchemaImpl(),
		subscriptions: registry,
	});

	const coordinator = new DispatchCoordinator({
		registry,
		getSchema: async () => SCHEMA,
		messenger: messenger as never,
		closeConnection: (client, code) => controller.closeConnection(client, code),
		deliveryConcurrency: options.deliveryConcurrency ?? 1,
	});

	coordinator.start();

	const server = createServer();
	server.on('upgrade', controller.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as AddressInfo).port;

	const sockets: WebSocket[] = [];

	const teardown = async () => {
		for (const socket of sockets) socket.terminate();
		await coordinator.stop();
		await controller.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { controller, coordinator, registry, messenger, port, sockets, teardown };
}

interface Connected {
	ws: WebSocket;
	frames: Record<string, any>[];
	closed: Promise<{ code: number }>;
}

function connect(harness: Harness): Promise<Connected> {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/graphql`, 'graphql-transport-ws');
	harness.sockets.push(ws);

	const frames: Record<string, any>[] = [];
	ws.on('message', (data) => frames.push(JSON.parse(data.toString())));

	const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })));

	return new Promise((resolve, reject) => {
		ws.on('open', () => resolve({ ws, frames, closed }));
		ws.on('error', reject);
	});
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
	ws.send(JSON.stringify(message));
}

async function subscribed(harness: Harness, query: string, token?: string): Promise<Connected> {
	const connection = await connect(harness);

	send(
		connection.ws,
		token === undefined ? { type: 'connection_init' } : { type: 'connection_init', payload: { access_token: token } }
	);

	await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));
	send(connection.ws, { type: 'subscribe', id: 'sub', payload: { query } });

	await vi.waitFor(() =>
		expect(
			harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER).length +
				harness.registry.getActiveByCollection('posts', Number.MAX_SAFE_INTEGER).length
		).toBeGreaterThan(0)
	);

	return connection;
}

function nextFrames(frames: Record<string, any>[]): Record<string, any>[] {
	return frames.filter((frame) => frame['type'] === 'next' && frame['id'] === 'sub');
}

async function settleUntil(condition: () => boolean, max = 100): Promise<void> {
	for (let index = 0; index < max && !condition(); index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

let harness: Harness | null = null;

beforeEach(() => {
	getEnv()['SECRET'] = TEST_SECRET;
	readImpl = (_accountability, _event, key) => [{ id: key, title: `title-${key}` }];
	readAccountability = null;
	stallWhen = null;
	stallGate = Promise.resolve();
	permissionsError = null;
	permissionsResult = [];
	targetUnavailable = false;
	eligibilityCalls = 0;
	getEventPayloadCalls = 0;
	getQueryError = null;
	readDeep = undefined;
	subscriptionDeep = undefined;
	getSchemaImpl = async () => SCHEMA;
	loggedPayloads.length = 0;
});

afterEach(async () => {
	if (harness) await harness.teardown();
	harness = null;
	vi.useRealTimers();
	getEnv()['SECRET'] = originalSecret;
});

describe('Rendezvous', () => {
	it('delivers an event pushed before a pull', async () => {
		const channel = new Rendezvous();
		const controller = new AbortController();
		void channel.push({ action: 'create', collection: 'articles', key: '1' }, controller.signal);
		const pulled = await channel.pull();
		expect(pulled).toEqual({ done: false, event: { action: 'create', collection: 'articles', key: '1' } });
	});

	it('delivers an event pushed after a pull is waiting', async () => {
		const channel = new Rendezvous();
		const controller = new AbortController();
		const pull = channel.pull();
		void channel.push({ action: 'create', collection: 'articles', key: '2' }, controller.signal);
		expect(await pull).toEqual({ done: false, event: { action: 'create', collection: 'articles', key: '2' } });
	});

	it('acknowledges a push only when the generator pulls the following event', async () => {
		const channel = new Rendezvous();
		const controller = new AbortController();

		let acknowledged = false;

		void channel.push({ action: 'create', collection: 'articles', key: '3' }, controller.signal).then(() => {
			acknowledged = true;
		});

		await channel.pull();
		await new Promise((resolve) => setImmediate(resolve));
		expect(acknowledged).toBe(false);

		void channel.pull();
		await new Promise((resolve) => setImmediate(resolve));
		expect(acknowledged).toBe(true);
	});

	it('settles a waiting pull and a pending push on close', async () => {
		const channel = new Rendezvous();
		const controller = new AbortController();

		let acknowledged = false;

		void channel.push({ action: 'create', collection: 'articles', key: '4' }, controller.signal).then(() => {
			acknowledged = true;
		});

		await channel.pull();
		const pull = channel.pull();
		channel.close();

		expect(await pull).toEqual({ done: true });
		await new Promise((resolve) => setImmediate(resolve));
		expect(acknowledged).toBe(true);
	});

	it('settles the push when the signal aborts', async () => {
		const channel = new Rendezvous();
		const controller = new AbortController();

		let settled = false;

		void channel.push({ action: 'create', collection: 'articles', key: '5' }, controller.signal).then(() => {
			settled = true;
		});

		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(true);
	});
});

describe('resolveSubscriptionTarget', () => {
	function target(query: string, variables: Record<string, unknown> = {}) {
		const document = parse(query);
		const operation = getOperationAST(document)!;
		return resolveSubscriptionTarget(TEST_SCHEMA, operation, document, variables);
	}

	it('reads the collection from a _mutated field', () => {
		expect(target('subscription { articles_mutated }')).toEqual({ collection: 'articles' });
	});

	it('reads an inline event enum argument', () => {
		expect(target('subscription { articles_mutated(event: update) }')).toEqual({
			collection: 'articles',
			event: 'update',
		});
	});

	it('resolves an event argument supplied as a variable', () => {
		expect(target('subscription ($e: EventEnum) { articles_mutated(event: $e) }', { e: 'delete' })).toEqual({
			collection: 'articles',
			event: 'delete',
		});
	});

	it('applies a variable default when the argument is omitted', () => {
		expect(target('subscription ($e: EventEnum = update) { articles_mutated(event: $e) }')).toEqual({
			collection: 'articles',
			event: 'update',
		});
	});

	it('reads the collection through a root fragment spread', () => {
		expect(target('subscription { ...Sub } fragment Sub on Subscription { articles_mutated }')).toEqual({
			collection: 'articles',
		});
	});

	it('surfaces variable coercion errors', () => {
		const result = target('subscription ($e: EventEnum!) { articles_mutated(event: $e) }', { e: 'nope' });
		expect(result.collection).toBe('');
		expect(result.errors).toBeDefined();
	});

	it('returns an empty collection for a non-mutated field', () => {
		expect(target('subscription { ok }')).toEqual({ collection: '' });
	});
});

describe('parseFields', () => {
	function capturingService() {
		const captured: unknown[] = [];

		const service = {
			getQuery: (_raw: unknown, selections: readonly unknown[]) => {
				captured.push(selections);
				return { fields: ['id'] };
			},
			accountability: null,
		} as unknown as Parameters<typeof parseFields>[0];

		return { service, captured };
	}

	function resolveInfo(query: string): GraphQLResolveInfo {
		const document = parse(query);
		const operation = getOperationAST(document) as any;
		const fragments: Record<string, unknown> = {};

		for (const definition of document.definitions) {
			if (definition.kind === 'FragmentDefinition') fragments[definition.name.value] = definition;
		}

		return {
			fieldNodes: operation.selectionSet.selections,
			variableValues: {},
			fragments,
		} as unknown as GraphQLResolveInfo;
	}

	it('maps the data sub-selection to query fields', () => {
		const { service, captured } = capturingService();

		expect(parseFields(service, resolveInfo('subscription { articles_mutated { data { id title } } }'))).toEqual({
			fields: ['id'],
		});

		expect((captured[0] as unknown[]).length).toBe(2);
	});

	it('expands a fragment spread nested inside the data selection', () => {
		const { service, captured } = capturingService();

		parseFields(
			service,
			resolveInfo('subscription { articles_mutated { data { ...Fields } } } fragment Fields on articles { id title }')
		);

		const handed = captured[0] as { kind: string; name?: { value: string } }[];
		expect(handed.every((selection) => selection.kind === 'Field')).toBe(true);
		expect(handed.map((selection) => selection.name?.value)).toEqual(['id', 'title']);
	});

	it('collects a data selection that is itself behind a fragment', () => {
		const { service, captured } = capturingService();

		parseFields(
			service,
			resolveInfo('subscription { articles_mutated { ...D } } fragment D on articles_mutated { data { id title } }')
		);

		expect((captured[0] as unknown[]).length).toBe(2);
	});

	it('carries the deep query returned by getQuery', () => {
		const deep = { author: { _limit: 1 } };

		const service = {
			getQuery: () => ({ fields: ['id'], deep }),
			accountability: null,
		} as unknown as Parameters<typeof parseFields>[0];

		expect(parseFields(service, resolveInfo('subscription { articles_mutated { data { id } } }'))).toEqual({
			fields: ['id'],
			deep,
		});
	});
});

describe('GraphQL subscription delivery', () => {
	const QUERY = 'subscription { articles_mutated { key event data { id title } } }';

	it('delivers a shaped next frame for a create event', async () => {
		harness = await createHarness();
		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '7' });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));

		expect(nextFrames(frames)[0]!['payload']['data']['articles_mutated']).toEqual({
			key: '7',
			event: 'create',
			data: { id: '7', title: 'title-7' },
		});
	});

	it('yields nothing when the permission-checked read is empty', async () => {
		harness = await createHarness();
		readImpl = () => [];
		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '8' });

		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(nextFrames(frames)).toHaveLength(0);
	});

	it('drops rows the refreshed accountability cannot read', async () => {
		harness = await createHarness();

		readImpl = (accountability, _event, key) =>
			accountability.user === null ? [] : [{ id: key, title: `title-${key}` }];

		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '9' });

		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(nextFrames(frames)).toHaveLength(0);
	});

	it('delivers rows the authenticated accountability can read', async () => {
		harness = await createHarness();

		readImpl = (accountability, _event, key) =>
			accountability.user === 'alice' ? [{ id: key, title: `title-${key}` }] : [];

		const { frames } = await subscribed(harness, QUERY, signUser('alice'));

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '13' });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));
	});

	it('reads only the parsed data selection fields', async () => {
		harness = await createHarness();
		readFields = undefined;
		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '14' });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));
		expect(readFields).toEqual(['id', 'title']);
	});

	it('carries the parsed deep query into the delivery read', async () => {
		subscriptionDeep = { author: { _limit: 1 } };
		harness = await createHarness();
		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '20' });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));
		expect(readDeep).toEqual({ author: { _limit: 1 } });
	});

	it('yields once per key for a batch update', async () => {
		harness = await createHarness();
		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'update', collection: 'articles', keys: ['10', '11'] });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(2));

		expect(nextFrames(frames).map((frame) => frame['payload']['data']['articles_mutated']['key'])).toEqual([
			'10',
			'11',
		]);
	});

	it('redacts a variable-derived secret in a resolver error on both the wire and the log', async () => {
		harness = await createHarness();
		readImpl = (_accountability, _event, key) => [{ id: key, title: 'x', secret: 'boom' }];

		const connection = await connect(harness);
		send(connection.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));

		send(connection.ws, {
			type: 'subscribe',
			id: 'sub',
			payload: {
				query: 'subscription ($token: String) { articles_mutated(token: $token) { key data { secret } } }',
				variables: { token: READ_SECRET },
			},
		});

		await settleUntil(() => harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER).length === 1);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '12' });

		await vi.waitFor(() => expect(nextFrames(connection.frames)).toHaveLength(1));
		const frame = nextFrames(connection.frames)[0]!;
		expect(JSON.stringify(frame)).not.toContain(READ_SECRET);
		expect(frame['payload']['errors'][0]['message']).toBe('An unexpected error occurred.');

		expect(loggedPayloads.length).toBeGreaterThan(0);
		expect(loggedPayloads.some((payload) => payload.includes(READ_SECRET))).toBe(false);
	});

	it('removes the reservation when the client completes the subscription', async () => {
		harness = await createHarness();
		const { ws } = await subscribed(harness, QUERY);

		expect(harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1);

		send(ws, { type: 'complete', id: 'sub' });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(0)
		);
	});

	it('settles a subscription blocked on an empty channel during shutdown', async () => {
		harness = await createHarness();
		await subscribed(harness, QUERY);

		expect(harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1);

		await harness.controller.terminate();
		expect(harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(0);
	});

	it('closes every subscriber with 1013 on a process-wide overload', async () => {
		harness = await createHarness();
		const { closed } = await subscribed(harness, QUERY);

		for (let index = 0; index <= 1000; index++) {
			harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: String(index) });
		}

		expect((await closed).code).toBe(1013);
	});

	it('keeps one collection progressing while another stalls on its read', async () => {
		harness = await createHarness({ deliveryConcurrency: 2 });

		let releaseArticles!: () => void;

		stallGate = new Promise<void>((resolve) => {
			releaseArticles = resolve;
		});

		stallWhen = (subscription) => subscription.collection === 'articles';

		const articles = await subscribed(harness, 'subscription { articles_mutated { key } }');

		const posts = await connect(harness);
		send(posts.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(posts.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));
		send(posts.ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { posts_mutated { key } }' } });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('posts', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '30' });
		harness.messenger.publish('websocket.event', { action: 'create', collection: 'posts', key: '31' });

		await vi.waitFor(() => expect(nextFrames(posts.frames)).toHaveLength(1));
		expect(nextFrames(articles.frames)).toHaveLength(0);

		releaseArticles();
		await vi.waitFor(() => expect(nextFrames(articles.frames)).toHaveLength(1));
	});

	it('delivers events in order per collection', async () => {
		harness = await createHarness();
		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '60' });
		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '61' });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(2));

		expect(nextFrames(frames).map((frame) => frame['payload']['data']['articles_mutated']['key'])).toEqual([
			'60',
			'61',
		]);
	});

	it('streams keys one at a time so a stalled key does not hold back earlier keys', async () => {
		harness = await createHarness();

		let releaseSecond!: () => void;

		stallGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});

		stallWhen = (subscription) => subscription.item === '71';

		const { frames } = await subscribed(harness, QUERY);

		harness.messenger.publish('websocket.event', { action: 'update', collection: 'articles', keys: ['70', '71'] });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));
		expect(nextFrames(frames)[0]!['payload']['data']['articles_mutated']['key']).toBe('70');

		releaseSecond();
		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(2));
		expect(nextFrames(frames)[1]!['payload']['data']['articles_mutated']['key']).toBe('71');
	});

	it('stops delivering a stalled batch when the subscription is completed mid-batch', async () => {
		harness = await createHarness();

		let releaseSecond: () => void = () => undefined;

		stallGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});

		stallWhen = (subscription) => subscription.item === '71';

		const { ws, frames } = await subscribed(harness, QUERY);

		try {
			harness.messenger.publish('websocket.event', { action: 'update', collection: 'articles', keys: ['70', '71'] });

			await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));
			expect(nextFrames(frames)[0]!['payload']['data']['articles_mutated']['key']).toBe('70');

			send(ws, { type: 'complete', id: 'sub' });
			await vi.waitFor(() => expect(harness!.registry.getSubscribedOwners()).toHaveLength(0));

			stallWhen = null;
			send(ws, { type: 'subscribe', id: 'sub', payload: { query: QUERY } });
			releaseSecond();

			await vi.waitFor(() =>
				expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
			);

			harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '80' });

			await vi.waitFor(() =>
				expect(nextFrames(frames).some((frame) => frame['payload']['data']['articles_mutated']['key'] === '80')).toBe(
					true
				)
			);
		} finally {
			releaseSecond();
		}

		expect(nextFrames(frames).some((frame) => frame['payload']['data']['articles_mutated']['key'] === '71')).toBe(
			false
		);
	});

	it('does not error or close the connection when a stalled delivery schema load rejects after completion', async () => {
		harness = await createHarness();
		const { ws, frames, closed } = await subscribed(harness, QUERY);

		let rejectSchema: (error: Error) => void = () => undefined;
		let loadReached: () => void = () => undefined;

		const loadEntered = new Promise<void>((resolve) => {
			loadReached = resolve;
		});

		getSchemaImpl = () => {
			loadReached();
			return new Promise<SchemaOverview>((_resolve, reject) => {
				rejectSchema = reject;
			});
		};

		let closedEarly = false;

		void closed.then(() => {
			closedEarly = true;
		});

		try {
			harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '30' });
			await loadEntered;

			send(ws, { type: 'complete', id: 'sub' });
			await vi.waitFor(() => expect(harness!.registry.getSubscribedOwners()).toHaveLength(0));

			rejectSchema(new Error('schema load failed'));

			getSchemaImpl = async () => SCHEMA;
			send(ws, { type: 'subscribe', id: 'sub', payload: { query: QUERY } });

			await vi.waitFor(() =>
				expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
			);

			harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '31' });

			await vi.waitFor(() =>
				expect(nextFrames(frames).some((frame) => frame['payload']['data']['articles_mutated']['key'] === '31')).toBe(
					true
				)
			);
		} finally {
			rejectSchema(new Error('cleanup'));
		}

		expect(frames.some((frame) => frame['type'] === 'error' && frame['id'] === 'sub')).toBe(false);
		expect(closedEarly).toBe(false);
	});

	it('reads under the freshly snapshotted accountability for each event', async () => {
		harness = await createHarness();
		const { frames } = await subscribed(harness, QUERY, signUser('alice'));

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '40' });

		await vi.waitFor(() => expect(nextFrames(frames)).toHaveLength(1));
		expect(readAccountability?.user).toBe('alice');
	});

	it('rejects a subscription past the per-connection reservation limit', async () => {
		harness = await createHarness();
		const { ws, frames } = await subscribed(harness, QUERY);

		send(ws, { type: 'subscribe', id: 'sub2', payload: { query: QUERY } });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(2)
		);

		send(ws, { type: 'subscribe', id: 'sub3', payload: { query: QUERY } });

		await vi.waitFor(() =>
			expect(frames.some((frame) => frame['type'] === 'error' && frame['id'] === 'sub3')).toBe(true)
		);

		const errFrame = frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'sub3');
		expect(errFrame!['payload'][0]['extensions']['code']).toBe('SERVICE_UNAVAILABLE');
		expect(harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(2);
	});

	it('finalizes and releases the delivery permit when a per-event read setup throws', async () => {
		harness = await createHarness();
		await subscribed(harness, QUERY);

		const posts = await connect(harness);
		send(posts.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(posts.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));
		send(posts.ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { posts_mutated { key } }' } });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('posts', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		permissionsError = new Error('read setup failed');
		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '80' });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(0)
		);

		permissionsError = null;
		harness.messenger.publish('websocket.event', { action: 'create', collection: 'posts', key: '81' });

		await vi.waitFor(() =>
			expect(posts.frames.some((frame) => frame['type'] === 'next' && frame['id'] === 'sub')).toBe(true)
		);
	});

	it('never activates and settles the reservation when completed before its iterable installs', async () => {
		harness = await createHarness();

		let releaseSchema!: () => void;
		let schemaReached!: () => void;

		const schemaGate = new Promise<void>((resolve) => {
			releaseSchema = resolve;
		});

		const schemaEntered = new Promise<void>((resolve) => {
			schemaReached = resolve;
		});

		let activateSpy: ReturnType<typeof vi.spyOn> | undefined;
		let capturedReservation: { settled: Promise<void> } | null = null;
		const reserve = harness.registry.reserve.bind(harness.registry);

		vi.spyOn(harness.registry, 'reserve').mockImplementation((subscription) => {
			const result = reserve(subscription);

			if (result.ok) {
				capturedReservation = result.reservation;
				activateSpy = vi.spyOn(result.reservation, 'activate');
			}

			return result;
		});

		const connection = await connect(harness);
		send(connection.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));

		getSchemaImpl = async () => {
			schemaReached();
			await schemaGate;
			return SCHEMA;
		};

		send(connection.ws, { type: 'subscribe', id: 'sub', payload: { query: QUERY } });
		await schemaEntered;
		send(connection.ws, { type: 'complete', id: 'sub' });
		await settleUntil(() => false, 5);

		releaseSchema();
		await vi.waitFor(() => expect(capturedReservation).not.toBeNull());
		await capturedReservation!.settled;

		expect(activateSpy).not.toHaveBeenCalled();
		expect(harness.registry.getSubscribedOwners()).toHaveLength(0);
	});

	it('cleans up stored variables when an invalid operation is completed during its schema lookup', async () => {
		harness = await createHarness();

		let releaseSchema!: () => void;
		let schemaReached!: () => void;

		const schemaGate = new Promise<void>((resolve) => {
			releaseSchema = resolve;
		});

		const schemaEntered = new Promise<void>((resolve) => {
			schemaReached = resolve;
		});

		const connection = await connect(harness);
		send(connection.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));

		getSchemaImpl = async () => {
			schemaReached();
			await schemaGate;
			return SCHEMA;
		};

		send(connection.ws, {
			type: 'subscribe',
			id: 'sub',
			payload: { query: 'subscription { nonexistent }', variables: { token: 'x' } },
		});

		await schemaEntered;
		send(connection.ws, { type: 'complete', id: 'sub' });
		await settleUntil(() => false, 5);

		releaseSchema();
		await settleUntil(() => false, 10);

		const client = [...harness.controller.clientSnapshot()][0]!;

		const adapter = (
			harness.controller as unknown as { adapters: WeakMap<object, { variables: Map<string, unknown> }> }
		).adapters.get(client)!;

		expect(adapter.variables.has('sub')).toBe(false);
	});

	it('closes 1009 and releases the delivery permit when a delivered frame exceeds the outbound cap', async () => {
		harness = await createHarness();

		readImpl = (_accountability, event, key) =>
			event.collection === 'articles' ? [{ id: key, title: 'x'.repeat(1_100_000) }] : [{ id: key }];

		const articles = await subscribed(harness, QUERY);

		const posts = await connect(harness);
		send(posts.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(posts.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));
		send(posts.ws, { type: 'subscribe', id: 'sub', payload: { query: 'subscription { posts_mutated { key } }' } });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('posts', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '90' });
		expect((await articles.closed).code).toBe(1009);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'posts', key: '91' });

		await vi.waitFor(() =>
			expect(posts.frames.some((frame) => frame['type'] === 'next' && frame['id'] === 'sub')).toBe(true)
		);
	});

	it('settles the dispatch barrier when an initializing reservation is finalized on setup failure', async () => {
		harness = await createHarness();

		let barrierSettled = false;
		const reserve = harness.registry.reserve.bind(harness.registry);

		vi.spyOn(harness.registry, 'reserve').mockImplementation((subscription) => {
			const result = reserve(subscription);

			if (result.ok) {
				const context = harness!.registry.captureDispatchContext(subscription.collection);

				void context.barrier.wait(new AbortController().signal).then(() => {
					barrierSettled = true;
				});
			}

			return result;
		});

		getQueryError = new Error('generator setup failed');

		const connection = await connect(harness);
		send(connection.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));

		send(connection.ws, { type: 'subscribe', id: 'sub', payload: { query: QUERY } });

		await vi.waitFor(() => expect(barrierSettled).toBe(true));
	});

	it('serializes a reused operation id so a completed subscription cannot corrupt its successor', async () => {
		harness = await createHarness();

		let releaseSchema!: () => void;
		let schemaReached!: () => void;

		const schemaGate = new Promise<void>((resolve) => {
			releaseSchema = resolve;
		});

		const schemaEntered = new Promise<void>((resolve) => {
			schemaReached = resolve;
		});

		const connection = await connect(harness);
		send(connection.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));

		getSchemaImpl = async () => {
			schemaReached();
			await schemaGate;
			return SCHEMA;
		};

		send(connection.ws, { type: 'subscribe', id: 'x', payload: { query: QUERY } });
		await schemaEntered;
		send(connection.ws, { type: 'complete', id: 'x' });
		send(connection.ws, { type: 'subscribe', id: 'x', payload: { query: QUERY } });
		await settleUntil(() => false, 5);

		releaseSchema();

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '100' });

		await vi.waitFor(() =>
			expect(connection.frames.some((frame) => frame['type'] === 'next' && frame['id'] === 'x')).toBe(true)
		);

		expect(connection.frames.some((frame) => frame['type'] === 'error' && frame['id'] === 'x')).toBe(false);
		expect(harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1);

		send(connection.ws, { type: 'complete', id: 'x' });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(0)
		);

		expect(harness.registry.getSubscribedOwners()).toHaveLength(0);
	});

	it('cancels a queued reused subscription on a server-triggered stop so it never reserves during teardown', async () => {
		harness = await createHarness();

		let schemaCalls = 0;
		let releaseSchema!: () => void;
		let schemaReached!: () => void;

		const schemaGate = new Promise<void>((resolve) => {
			releaseSchema = resolve;
		});

		const schemaEntered = new Promise<void>((resolve) => {
			schemaReached = resolve;
		});

		const connection = await connect(harness);
		send(connection.ws, { type: 'connection_init' });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));

		getSchemaImpl = async () => {
			schemaCalls++;

			if (schemaCalls === 1) {
				schemaReached();
				await schemaGate;
			}

			return SCHEMA;
		};

		send(connection.ws, { type: 'subscribe', id: 'x', payload: { query: QUERY } });
		await schemaEntered;
		send(connection.ws, { type: 'complete', id: 'x' });
		send(connection.ws, { type: 'subscribe', id: 'x', payload: { query: QUERY } });
		await settleUntil(() => false, 5);

		const terminated = harness.controller.terminate();
		releaseSchema();
		await terminated;

		expect(schemaCalls).toBe(1);
		expect(harness.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(0);
		expect(harness.registry.getSubscribedOwners()).toHaveLength(0);
	});

	it('drops private rows but keeps public rows after a public token expiry re-reads as anonymous', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

		harness = await createHarness();

		readImpl = (accountability, _event, key) =>
			accountability.user === 'alice' || String(key).startsWith('public') ? [{ id: key, title: 'x' }] : [];

		const token = jwt.sign({ id: 'alice', role: 'role-1', app_access: true, admin_access: false }, secret(), {
			issuer: 'cairncms',
			expiresIn: '3600s',
		});

		const connection = await connect(harness);

		const acked = new Promise<void>((resolve) => {
			connection.ws.on('message', (data) => {
				if (JSON.parse(data.toString())['type'] === 'connection_ack') resolve();
			});
		});

		send(connection.ws, { type: 'connection_init', payload: { access_token: token } });
		await acked;

		send(connection.ws, { type: 'subscribe', id: 'sub', payload: { query: QUERY } });
		await settleUntil(() => harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER).length === 1);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: 'private-0' });
		await settleUntil(() => nextFrames(connection.frames).length === 1);
		expect(nextFrames(connection.frames)).toHaveLength(1);

		vi.advanceTimersByTime(3_600_000);
		await settleUntil(() => false, 20);

		readAccountability = null;
		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: 'private-1' });
		await settleUntil(() => readAccountability !== null);
		expect(readAccountability?.user).toBe(null);
		expect(nextFrames(connection.frames)).toHaveLength(1);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: 'public-1' });
		await settleUntil(() => nextFrames(connection.frames).length === 2);
		expect(nextFrames(connection.frames)).toHaveLength(2);
	});
});

describe('GraphQL delete feed', () => {
	const UNCONDITIONAL_READ = [{ collection: 'articles', action: 'read', permissions: {}, fields: ['*'] }];

	const CONDITIONAL_READ = [
		{ collection: 'articles', action: 'read', permissions: { status: { _eq: 'published' } }, fields: ['*'] },
	];

	const DELETE_QUERY = 'subscription { articles_mutated(event: delete) { key event } }';

	async function ack(connection: Connected, token: string): Promise<void> {
		send(connection.ws, { type: 'connection_init', payload: { access_token: token } });
		await vi.waitFor(() => expect(connection.frames.some((frame) => frame['type'] === 'connection_ack')).toBe(true));
	}

	function framesFor(connection: Connected, id: string): Record<string, any>[] {
		return connection.frames.filter((frame) => frame['id'] === id);
	}

	it('delivers a per-key delete notification to an eligible reader without a row read', async () => {
		harness = await createHarness();
		permissionsResult = UNCONDITIONAL_READ;

		const { frames } = await subscribed(harness, DELETE_QUERY, signUser('alice'));

		harness.messenger.publish('websocket.event', { action: 'delete', collection: 'articles', keys: ['10', '20'] });
		await settleUntil(() => nextFrames(frames).length === 2);

		expect(nextFrames(frames).map((frame) => frame['payload']['data']['articles_mutated'])).toEqual([
			{ key: '10', event: 'delete' },
			{ key: '20', event: 'delete' },
		]);

		expect(getEventPayloadCalls).toBe(0);
	});

	it('accepts an eligible delete subscription carrying a normal data selection', async () => {
		harness = await createHarness();
		permissionsResult = UNCONDITIONAL_READ;

		const { frames } = await subscribed(
			harness,
			'subscription { articles_mutated(event: delete) { key data { id title } } }',
			signUser('alice')
		);

		harness.messenger.publish('websocket.event', { action: 'delete', collection: 'articles', keys: ['10'] });
		await settleUntil(() => nextFrames(frames).length === 1);

		expect(nextFrames(frames)[0]!['payload']['data']['articles_mutated']).toEqual({ key: '10', data: null });
	});

	it('never delivers a delete to an event-unset subscription but keeps it active for a later create', async () => {
		harness = await createHarness();

		const { frames } = await subscribed(harness, 'subscription { articles_mutated { key event } }', signUser('alice'));

		harness.messenger.publish('websocket.event', { action: 'delete', collection: 'articles', keys: ['10'] });
		await settleUntil(() => false, 15);
		expect(nextFrames(frames)).toHaveLength(0);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '99' });
		await settleUntil(() => nextFrames(frames).length === 1);
		expect(nextFrames(frames)).toHaveLength(1);
	});

	it('rejects a delete subscription from a conditional reader with a fixed forbidden error and no reservation', async () => {
		harness = await createHarness();
		permissionsResult = CONDITIONAL_READ;

		const connection = await connect(harness);
		await ack(connection, signUser('alice'));

		send(connection.ws, { type: 'subscribe', id: 'del', payload: { query: DELETE_QUERY } });

		await vi.waitFor(() =>
			expect(connection.frames.some((frame) => frame['type'] === 'error' && frame['id'] === 'del')).toBe(true)
		);

		const errFrame = connection.frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'del');
		expect(errFrame!['payload'][0]['extensions']['code']).toBe('FORBIDDEN');
		expect(harness.registry.getSubscribedOwners()).toHaveLength(0);
	});

	it('rejects a delete subscription with an unavailable target before the eligibility helper and creates no reservation', async () => {
		harness = await createHarness();
		permissionsResult = UNCONDITIONAL_READ;
		targetUnavailable = true;

		const connection = await connect(harness);
		await ack(connection, signUser('alice'));

		send(connection.ws, { type: 'subscribe', id: 'del', payload: { query: DELETE_QUERY } });

		await vi.waitFor(() =>
			expect(connection.frames.some((frame) => frame['type'] === 'error' && frame['id'] === 'del')).toBe(true)
		);

		const errFrame = connection.frames.find((frame) => frame['type'] === 'error' && frame['id'] === 'del');
		expect(errFrame!['payload'][0]['extensions']['code']).toBe('FORBIDDEN');
		expect(eligibilityCalls).toBe(0);
		expect(harness.registry.getSubscribedOwners()).toHaveLength(0);
	});

	it('silently retires a delete subscription on eligibility loss, keeping the connection and other operations alive', async () => {
		harness = await createHarness();
		permissionsResult = UNCONDITIONAL_READ;

		const connection = await connect(harness);
		await ack(connection, signUser('alice'));

		send(connection.ws, {
			type: 'subscribe',
			id: 'keep',
			payload: { query: 'subscription { articles_mutated { key } }' },
		});

		send(connection.ws, { type: 'subscribe', id: 'del', payload: { query: DELETE_QUERY } });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(2)
		);

		permissionsResult = CONDITIONAL_READ;
		harness.messenger.publish('websocket.event', { action: 'delete', collection: 'articles', keys: ['10'] });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		expect(framesFor(connection, 'del')).toHaveLength(0);

		// Same-lane settlement: the sequencer cannot activate a replacement on id `del` until the retired predecessor's
		// lifetime settles (past graphql-ws's emit.complete), so any terminal frame the predecessor might have emitted is
		// already queued server side by the time the replacement activates. The client-receipt guarantee comes from the
		// keep watermark below.
		send(connection.ws, {
			type: 'subscribe',
			id: 'del',
			payload: { query: 'subscription { articles_mutated { key } }' },
		});

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(2)
		);

		expect(framesFor(connection, 'del')).toHaveLength(0);

		send(connection.ws, { type: 'complete', id: 'del' });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'articles', key: '99' });

		await vi.waitFor(() =>
			expect(connection.frames.some((frame) => frame['type'] === 'next' && frame['id'] === 'keep')).toBe(true)
		);

		// `keep`'s next is queued only after the predecessor settled, and WebSocket preserves outbound frame order, so its
		// arrival on the client is a receipt watermark past which any terminal frame the predecessor queued would already
		// be present. `send` only enqueues server side, so this is the assertion that proves nothing reached the client.
		expect(framesFor(connection, 'del')).toHaveLength(0);
		expect(connection.ws.readyState).toBe(WebSocket.OPEN);
	});

	it('releases the delivery permit when a delete subscription retires so another collection progresses', async () => {
		harness = await createHarness({ deliveryConcurrency: 1 });
		permissionsResult = UNCONDITIONAL_READ;

		await subscribed(harness, DELETE_QUERY, signUser('alice'));
		const posts = await subscribed(harness, 'subscription { posts_mutated { key } }', signUser('alice'));

		permissionsResult = CONDITIONAL_READ;
		harness.messenger.publish('websocket.event', { action: 'delete', collection: 'articles', keys: ['10'] });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(0)
		);

		harness.messenger.publish('websocket.event', { action: 'create', collection: 'posts', key: '5' });

		await vi.waitFor(() =>
			expect(posts.frames.some((frame) => frame['type'] === 'next' && frame['id'] === 'sub')).toBe(true)
		);
	});
});
