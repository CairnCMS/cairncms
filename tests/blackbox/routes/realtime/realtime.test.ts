import config, { Env, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { WebSocket as WsImpl } from 'ws';
import { collectionFirst } from './realtime.seed';

// Cross-instance tests require a database shared by multiple processes.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeFn = supportedVendors.length > 0 ? describe : describe.skip;

const REDIS = 'redis://127.0.0.1:6108/6';
const TOKEN = common.USER.ADMIN.TOKEN;
const HANDSHAKE = { authMode: 'handshake' as const, auth: { access_token: TOKEN } };
const STRICT = { authMode: 'strict' as const, auth: { access_token: TOKEN } };
const GQL_DATA = { event: true, data: { id: true, name: true } };
const GQL_DELETE = { event: true, key: true, data: { id: true, name: true } };

function clearMessenger(block: Record<string, string>): void {
	for (const key of Object.keys(block)) {
		if (key.startsWith('MESSENGER_')) delete block[key];
	}
}

function realtimeEnv(vendor: string, offset: number, authMode: 'handshake' | 'strict', namespace: string): Env {
	const env = cloneDeep(config.envs);
	const block = env[vendor as keyof Env]!;
	clearMessenger(block);

	const port = Number(block.PORT) + offset;
	block.PORT = String(port);
	block.PUBLIC_URL = `http://127.0.0.1:${port}`;
	block.MESSENGER_STORE = 'redis';
	block.MESSENGER_REDIS = REDIS;
	block.MESSENGER_NAMESPACE = namespace;
	block.WEBSOCKETS_ENABLED = 'true';
	block.WEBSOCKETS_REST_ENABLED = 'true';
	block.WEBSOCKETS_GRAPHQL_ENABLED = 'true';
	block.WEBSOCKETS_REST_AUTH = authMode;
	block.WEBSOCKETS_GRAPHQL_AUTH = authMode;
	block.WEBSOCKETS_REST_PATH = '/websocket';
	block.WEBSOCKETS_GRAPHQL_PATH = '/graphql';

	return env;
}

function portOf(env: Env, vendor: string): number {
	return Number(env[vendor as keyof Env]!.PORT);
}

function urlOf(vendor: string, env: Env): string {
	return `http://127.0.0.1:${portOf(env, vendor)}`;
}

function spawnInstance(env: Env, vendor: string): ChildProcess {
	return spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
		cwd: paths.cwd,
		env: env[vendor as keyof Env],
	});
}

function awaitExit(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once('exit', () => resolve());
	});
}

async function insertItem(url: string, collection: string, name: string, pkType: common.PrimaryKeyType): Promise<any> {
	const response = await request(url)
		.post(`/items/${collection}`)
		.send({ id: pkType === 'string' ? uuid() : undefined, name })
		.set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(200);
	expect(response.body.data.id).toBeDefined();

	return response.body.data.id;
}

async function updateItem(url: string, collection: string, id: any, name: string): Promise<void> {
	const response = await request(url)
		.patch(`/items/${collection}/${id}`)
		.send({ name })
		.set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(200);
}

async function deleteItem(url: string, collection: string, id: any): Promise<void> {
	const response = await request(url).delete(`/items/${collection}/${id}`).set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(204);
}

describeFn('WebSocket realtime (general)', () => {
	const envs = {} as { [vendor: string]: { main: Env; peer: Env } };
	const children: ChildProcess[] = [];

	const matrix = supportedVendors.flatMap((vendor) => common.PRIMARY_KEY_TYPES.map((pkType) => ({ vendor, pkType })));

	beforeAll(async () => {
		const runId = uuid().slice(0, 8);
		const promises = [];

		for (const vendor of supportedVendors) {
			const namespace = `realtime-${vendor}-${runId}`;
			const main = realtimeEnv(vendor, 250, 'handshake', namespace);
			const peer = realtimeEnv(vendor, 300, 'strict', namespace);
			envs[vendor] = { main, peer };

			const serverMain = spawnInstance(main, vendor);
			const serverPeer = spawnInstance(peer, vendor);
			children.push(serverMain, serverPeer);

			promises.push(awaitDirectusConnection(portOf(main, vendor), serverMain));
			promises.push(awaitDirectusConnection(portOf(peer, vendor), serverPeer));
		}

		await Promise.all(promises);
	}, 180000);

	afterAll(async () => {
		for (const child of children) child.kill();
		await Promise.all(children.map(awaitExit));
	});

	describe('Subscriptions deliver across instances on both transports', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const { main, peer } = envs[vendor]!;
				const mainUrl = urlOf(vendor, main);

				let peerConnected = false;

				const ws = common.createWebSocketConn(mainUrl, HANDSHAKE);
				const wsPeer = common.createWebSocketConn(urlOf(vendor, peer), STRICT);
				const wsGql = common.createWebSocketGql(mainUrl, HANDSHAKE);

				// Strict authentication must override these intentionally conflicting caller options.
				const wsGqlPeer = common.createWebSocketGql(urlOf(vendor, peer), {
					...STRICT,
					client: {
						url: 'ws://127.0.0.1:1/intentionally-wrong',
						webSocketImpl: WsImpl as unknown as typeof globalThis.WebSocket,
						connectionParams: { access_token: 'not-the-real-token' },
						on: {
							connected: () => {
								peerConnected = true;
							},
						},
					},
				});

				try {
					await ws.subscribe({ collection });
					await wsPeer.subscribe({ collection });
					const key = await wsGql.subscribe({ collection, jsonQuery: GQL_DATA });
					await wsGqlPeer.subscribe({ collection, jsonQuery: GQL_DATA });

					// connection_ack precedes registration, so delivery is the subscription barrier.
					await insertItem(mainUrl, collection, uuid(), 'integer');
					await ws.getMessages(1);
					await wsPeer.getMessages(1);
					await wsGql.getMessages(1);
					await wsGqlPeer.getMessages(1);

					const insertedName = uuid();
					const insertedId = await insertItem(mainUrl, collection, insertedName, 'integer');

					const restMain = await ws.getMessages(1);
					const restPeer = await wsPeer.getMessages(1);
					const gqlMain = await wsGql.getMessages(1);
					const gqlPeer = await wsGqlPeer.getMessages(1);

					expect(restMain![0]).toEqual({
						type: 'subscription',
						event: 'create',
						data: [{ id: insertedId, name: insertedName }],
					});

					expect(gqlMain![0]).toEqual({
						data: { [key]: { event: 'create', data: { id: String(insertedId), name: insertedName } } },
					});

					expect(restPeer).toEqual(restMain);
					expect(gqlPeer).toEqual(gqlMain);

					expect(peerConnected).toBe(true);
				} finally {
					ws.conn.close();
					wsPeer.conn.close();
					await wsGql.client.dispose();
					await wsGqlPeer.client.dispose();
				}
			},
			100000
		);
	});

	describe('Unsubscription stops delivery on both transports', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const { main } = envs[vendor]!;
				const mainUrl = urlOf(vendor, main);

				const ws = common.createWebSocketConn(mainUrl, HANDSHAKE);
				const wsGql = common.createWebSocketGql(mainUrl, HANDSHAKE);

				try {
					// Live uid 0 subscriptions are delivery barriers; a fixed GraphQL id permits raw completion.
					await ws.subscribe({ collection, uid: 'gone' });
					await ws.subscribe({ collection, uid: 0 });
					const key = await wsGql.subscribe({ collection, uid: 'goneGql', jsonQuery: GQL_DATA, protocolId: 'gone-op' });
					await wsGql.subscribe({ collection, uid: 0, jsonQuery: GQL_DATA });

					// Delivery confirms all four subscriptions are registered.
					await insertItem(mainUrl, collection, uuid(), 'integer');
					await ws.getMessages(1, { uid: 'gone' });
					await ws.getMessages(1, { uid: 0 });
					await wsGql.getMessages(1, { uid: 'goneGql' });
					await wsGql.getMessages(1, { uid: 0 });

					// The acknowledgement and live uid 0 feed bracket delivery without a timing assertion.
					await ws.unsubscribe('gone');
					const restGoneBaseline = ws.getMessageCount('gone');
					await insertItem(mainUrl, collection, uuid(), 'integer');
					expect((await ws.getMessages(1, { uid: 0 }))![0]).toMatchObject({ type: 'subscription', event: 'create' });
					expect(ws.getMessageCount('gone')).toBe(restGoneBaseline);

					// Same-id reuse is sequenced after finalization, making its error frame a deterministic barrier.
					await wsGql.sendRaw({ type: 'complete', id: 'gone-op' });

					await wsGql.sendRaw({
						id: 'gone-op',
						type: 'subscribe',
						payload: { query: 'subscription { zzz_nonexistent_collection_mutated { event } }' },
					});

					await wsGql.waitForFrame((frame) => frame.type === 'error' && frame.id === 'gone-op');

					const goneOpNext = () =>
						wsGql.getProtocolFrames().filter((frame) => frame.type === 'next' && frame.id === 'gone-op').length;

					const goneOpNextBaseline = goneOpNext();

					await insertItem(mainUrl, collection, uuid(), 'integer');

					expect((await wsGql.getMessages(1, { uid: 0 }))![0]).toMatchObject({ data: { [key]: { event: 'create' } } });

					expect(goneOpNext()).toBe(goneOpNextBaseline);
				} finally {
					ws.conn.close();
					await wsGql.client.dispose();
				}
			},
			100000
		);
	});

	describe('Event filtering, and event-unset never delivers delete', () => {
		it.each(matrix)(
			'$vendor / $pkType',
			async ({ vendor, pkType }) => {
				const collection = `${collectionFirst}_${pkType}`;
				const { main } = envs[vendor]!;
				const url = urlOf(vendor, main);

				const ws = common.createWebSocketConn(url, HANDSHAKE);
				const wsGql = common.createWebSocketGql(url, HANDSHAKE);

				try {
					await ws.subscribe({ collection, uid: 'all' });
					await ws.subscribe({ collection, uid: 'create', event: 'create' });
					await ws.subscribe({ collection, uid: 'update', event: 'update' });
					await ws.subscribe({ collection, uid: 'delete', event: 'delete' });
					const keyAll = await wsGql.subscribe({ collection, uid: 'allGql', jsonQuery: GQL_DATA });
					await wsGql.subscribe({ collection, uid: 'createGql', event: 'create', jsonQuery: GQL_DATA });
					await wsGql.subscribe({ collection, uid: 'updateGql', event: 'update', jsonQuery: GQL_DATA });
					await wsGql.subscribe({ collection, uid: 'deleteGql', event: 'delete', jsonQuery: GQL_DELETE });

					// Delivered prime events establish every filter before the measured lifecycle.
					const primeId = await insertItem(url, collection, uuid(), pkType);
					await updateItem(url, collection, primeId, `updated_${uuid()}`);
					await deleteItem(url, collection, primeId);
					await ws.getMessages(2, { uid: 'all' });
					await ws.getMessages(1, { uid: 'create' });
					await ws.getMessages(1, { uid: 'update' });
					await ws.getMessages(1, { uid: 'delete' });
					await wsGql.getMessages(2, { uid: 'allGql' });
					await wsGql.getMessages(1, { uid: 'createGql' });
					await wsGql.getMessages(1, { uid: 'updateGql' });
					await wsGql.getMessages(1, { uid: 'deleteGql' });

					const insertedName = uuid();
					const updatedName = `updated_${uuid()}`;
					const insertedId = await insertItem(url, collection, insertedName, pkType);
					await updateItem(url, collection, insertedId, updatedName);
					await deleteItem(url, collection, insertedId);

					expect((await ws.getMessages(1, { uid: 'create' }))![0]).toEqual({
						type: 'subscription',
						event: 'create',
						data: [{ id: insertedId, name: insertedName }],
						uid: 'create',
					});

					expect((await ws.getMessages(1, { uid: 'update' }))![0]).toEqual({
						type: 'subscription',
						event: 'update',
						data: [{ id: insertedId, name: updatedName }],
						uid: 'update',
					});

					const del = (await ws.getMessages(1, { uid: 'delete' }))![0];

					expect(del).toEqual({
						type: 'subscription',
						event: 'delete',
						data: [String(insertedId)],
						uid: 'delete',
					});

					expect((await wsGql.getMessages(1, { uid: 'createGql' }))![0]).toEqual({
						data: { [keyAll]: { event: 'create', data: { id: String(insertedId), name: insertedName } } },
					});

					expect((await wsGql.getMessages(1, { uid: 'updateGql' }))![0]).toEqual({
						data: { [keyAll]: { event: 'update', data: { id: String(insertedId), name: updatedName } } },
					});

					expect((await wsGql.getMessages(1, { uid: 'deleteGql' }))![0]).toEqual({
						data: { [keyAll]: { event: 'delete', key: String(insertedId), data: null } },
					});

					// Per-collection ordering makes the later create a barrier: any leaked delete would precede it.
					expect((await ws.getMessages(2, { uid: 'all' }))!.map((message) => message.event)).toEqual([
						'create',
						'update',
					]);

					expect((await wsGql.getMessages(2, { uid: 'allGql' }))!.map((message) => message.data[keyAll].event)).toEqual(
						['create', 'update']
					);

					const markerName = uuid();
					const markerId = await insertItem(url, collection, markerName, pkType);

					expect((await ws.getMessages(1, { uid: 'all' }))![0]).toEqual({
						type: 'subscription',
						event: 'create',
						data: [{ id: markerId, name: markerName }],
						uid: 'all',
					});

					expect((await wsGql.getMessages(1, { uid: 'allGql' }))![0]).toEqual({
						data: { [keyAll]: { event: 'create', data: { id: String(markerId), name: markerName } } },
					});
				} finally {
					ws.conn.close();
					await wsGql.client.dispose();
				}
			},
			120000
		);
	});

	describe('GraphQL transport option enforcement', () => {
		it.each(supportedVendors)(
			'%s: preserves a caller WebSocket implementation and generator outside strict',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const { main } = envs[vendor]!;
				const mainUrl = urlOf(vendor, main);

				let callerImplUsed = false;
				let callerId = 0;

				class FlaggingWebSocket extends WsImpl {
					constructor(address: string, protocols?: string | string[]) {
						callerImplUsed = true;
						super(address, protocols);
					}
				}

				const wsGql = common.createWebSocketGql(mainUrl, {
					...HANDSHAKE,
					client: {
						url: 'ws://127.0.0.1:1/intentionally-wrong',
						webSocketImpl: FlaggingWebSocket as unknown as typeof globalThis.WebSocket,
						generateID: () => `caller-${callerId++}`,
					},
				});

				try {
					await wsGql.subscribe({ collection, jsonQuery: GQL_DATA });
					await insertItem(mainUrl, collection, uuid(), 'integer');
					await wsGql.getMessages(1);

					expect(callerImplUsed).toBe(true);

					expect(
						wsGql.getProtocolFrames().some((frame) => frame.type === 'next' && String(frame.id).startsWith('caller-'))
					).toBe(true);
				} finally {
					await wsGql.client.dispose();
				}
			},
			100000
		);

		it.each(supportedVendors)(
			'%s: does not latch a pinned protocol id when subscription setup fails',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const { main } = envs[vendor]!;
				const mainUrl = urlOf(vendor, main);

				const wsGql = common.createWebSocketGql(mainUrl, HANDSHAKE);

				try {
					// null makes serialization throw after the explicit operation id is staged.
					await expect(
						wsGql.subscribe({ collection, jsonQuery: { data: null }, protocolId: 'leak-id' })
					).rejects.toBeDefined();

					await wsGql.subscribe({ collection, jsonQuery: GQL_DATA });
					await insertItem(mainUrl, collection, uuid(), 'integer');
					await wsGql.getMessages(1);

					const frames = wsGql.getProtocolFrames();
					expect(frames.some((frame) => frame.type === 'next' && frame.id === 'leak-id')).toBe(false);
					expect(frames.some((frame) => frame.type === 'next' && String(frame.id).startsWith('auto-'))).toBe(true);
				} finally {
					await wsGql.client.dispose();
				}
			},
			100000
		);
	});
});
