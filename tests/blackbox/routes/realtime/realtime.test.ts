import config, { Env, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { WebSocket as WsImpl } from 'ws';
import { createCairnCMS, realtime, staticToken } from '@cairncms/sdk';
import { collectionFirst, collectionScoped, realtimeUsers, TENANT_A, TENANT_B } from './realtime.seed';

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

type ItemFields = { tenant?: string; owner?: string };

async function insertItem(
	url: string,
	collection: string,
	name: string,
	pkType: common.PrimaryKeyType,
	fields?: ItemFields
): Promise<any> {
	const response = await request(url)
		.post(`/items/${collection}`)
		.send({ id: pkType === 'string' ? uuid() : undefined, name, ...fields })
		.set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(200);
	expect(response.body.data.id).toBeDefined();

	return response.body.data.id;
}

async function updateItem(url: string, collection: string, id: any, name: string, fields?: ItemFields): Promise<void> {
	const response = await request(url)
		.patch(`/items/${collection}/${id}`)
		.send({ name, ...fields })
		.set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(200);
}

async function deleteItem(url: string, collection: string, id: any): Promise<void> {
	const response = await request(url).delete(`/items/${collection}/${id}`).set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(204);
}

function handshakeAs(token: string) {
	return { authMode: 'handshake' as const, auth: { access_token: token } };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();

	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error('Condition not met within timeout');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withDeadline<T>(work: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;

	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
	});

	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer!);
	}
}

function gateEnv(vendor: string, offset: number, namespace: string): Env {
	const env = realtimeEnv(vendor, offset, 'handshake', namespace);
	const block = env[vendor as keyof Env]!;
	block.GRAPHQL_INTROSPECTION = 'false';
	block.GRAPHQL_QUERY_TOKEN_LIMIT = '10';

	return env;
}

async function resolveUserId(url: string, email: string): Promise<string> {
	const response = await request(url)
		.get('/users')
		.query({ filter: { email: { _eq: email } }, fields: ['id'] })
		.set('Authorization', `Bearer ${TOKEN}`);

	expect(response.statusCode).toBe(200);
	expect(response.body.data).toHaveLength(1);

	return response.body.data[0].id;
}

describeFn('WebSocket realtime', () => {
	const envs = {} as { [vendor: string]: { main: Env; peer: Env; gate: Env } };
	const children: ChildProcess[] = [];

	const matrix = supportedVendors.flatMap((vendor) => common.PRIMARY_KEY_TYPES.map((pkType) => ({ vendor, pkType })));

	beforeAll(async () => {
		const runId = uuid().slice(0, 8);
		const promises = [];

		for (const vendor of supportedVendors) {
			const namespace = `realtime-${vendor}-${runId}`;
			const main = realtimeEnv(vendor, 250, 'handshake', namespace);
			const peer = realtimeEnv(vendor, 300, 'strict', namespace);
			const gate = gateEnv(vendor, 350, `${namespace}-gate`);
			envs[vendor] = { main, peer, gate };

			const serverMain = spawnInstance(main, vendor);
			const serverPeer = spawnInstance(peer, vendor);
			const serverGate = spawnInstance(gate, vendor);
			children.push(serverMain, serverPeer, serverGate);

			promises.push(awaitDirectusConnection(portOf(main, vendor), serverMain));
			promises.push(awaitDirectusConnection(portOf(peer, vendor), serverPeer));
			promises.push(awaitDirectusConnection(portOf(gate, vendor), serverGate));
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

	describe('Multi-tenant row isolation and reassignment', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = collectionScoped;
				const url = urlOf(vendor, envs[vendor]!.main);

				const aRest = common.createWebSocketConn(url, handshakeAs(realtimeUsers.tenantA.token));
				const bRest = common.createWebSocketConn(url, handshakeAs(realtimeUsers.tenantB.token));
				const aGql = common.createWebSocketGql(url, handshakeAs(realtimeUsers.tenantA.token));
				const bGql = common.createWebSocketGql(url, handshakeAs(realtimeUsers.tenantB.token));

				try {
					await aRest.subscribe({ collection });
					await bRest.subscribe({ collection });
					const aKey = await aGql.subscribe({ collection, jsonQuery: GQL_DATA });
					const bKey = await bGql.subscribe({ collection, jsonQuery: GQL_DATA });

					const restId = (message: any) => message.data[0].id;
					const gqlId = (key: string, message: any) => message.data[key].data.id;

					const foreignB = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_B });
					const ownA = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_A });

					// The own-tenant row is dispatched after the foreign row, so a leaked foreign row would precede the
					// own-tenant watermark on the subscriber's ordered stream.
					expect(restId((await aRest.getMessages(1))![0])).toBe(ownA);
					expect(gqlId(aKey, (await aGql.getMessages(1))![0])).toBe(String(ownA));
					expect(restId((await bRest.getMessages(1))![0])).toBe(foreignB);
					expect(gqlId(bKey, (await bGql.getMessages(1))![0])).toBe(String(foreignB));

					const foreignA = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_A });
					const ownB = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_B });

					expect(restId((await bRest.getMessages(1))![0])).toBe(ownB);
					expect(gqlId(bKey, (await bGql.getMessages(1))![0])).toBe(String(ownB));
					expect(restId((await aRest.getMessages(1))![0])).toBe(foreignA);
					expect(gqlId(aKey, (await aGql.getMessages(1))![0])).toBe(String(foreignA));

					await updateItem(url, collection, ownA, uuid(), { tenant: TENANT_B });
					const ownAWatermark = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_A });
					const ownBWatermark = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_B });

					// Reassigning ownA to tenant B delivers the update to B alone. A's next frame is its own later create,
					// so a leaked reassignment update would precede it on A's ordered stream.
					expect(
						(await bRest.getMessages(2))!.map((message) => ({ event: message.event, id: restId(message) }))
					).toEqual([
						{ event: 'update', id: ownA },
						{ event: 'create', id: ownBWatermark },
					]);

					expect(
						(await bGql.getMessages(2))!.map((message) => ({
							event: message.data[bKey].event,
							id: gqlId(bKey, message),
						}))
					).toEqual([
						{ event: 'update', id: String(ownA) },
						{ event: 'create', id: String(ownBWatermark) },
					]);

					expect(restId((await aRest.getMessages(1))![0])).toBe(ownAWatermark);
					expect(gqlId(aKey, (await aGql.getMessages(1))![0])).toBe(String(ownAWatermark));
				} finally {
					aRest.conn.close();
					bRest.conn.close();
					await aGql.client.dispose();
					await bGql.client.dispose();
				}
			},
			120000
		);
	});

	describe('Delete-feed eligibility by read scope', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = collectionScoped;
				const url = urlOf(vendor, envs[vendor]!.main);

				const filteredRest = common.createWebSocketConn(url, handshakeAs(realtimeUsers.tenantA.token));
				const filteredGql = common.createWebSocketGql(url, handshakeAs(realtimeUsers.tenantA.token));
				const readerRest = common.createWebSocketConn(url, handshakeAs(realtimeUsers.readerAll.token));

				try {
					await filteredRest.sendMessage({ type: 'subscribe', collection, event: 'delete', uid: 'del' });

					expect((await filteredRest.getMessages(1, { uid: 'del' }))![0]).toMatchObject({
						type: 'subscribe',
						status: 'error',
						error: { code: 'DELETE_FEED_FORBIDDEN' },
						uid: 'del',
					});

					await filteredGql.subscribe({ collection, event: 'delete', uid: 'delGql', jsonQuery: GQL_DELETE });
					expect(String(JSON.stringify(await filteredGql.waitForError({ uid: 'delGql' })))).toMatch(/forbidden/i);

					await readerRest.subscribe({ collection, event: 'delete', uid: 'reader' });
					const targetId = await insertItem(url, collection, uuid(), 'integer', { tenant: TENANT_A });
					await deleteItem(url, collection, targetId);

					expect((await readerRest.getMessages(1, { uid: 'reader' }))![0]).toMatchObject({
						type: 'subscription',
						event: 'delete',
						data: [String(targetId)],
						uid: 'reader',
					});
				} finally {
					filteredRest.conn.close();
					readerRest.conn.close();
					await filteredGql.client.dispose();
				}
			},
			120000
		);
	});

	describe('Item and query scoped subscriptions', () => {
		it.each(supportedVendors)(
			'%s: item scope',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const url = urlOf(vendor, envs[vendor]!.main);

				const targetId = await insertItem(url, collection, uuid(), 'integer');
				const otherId = await insertItem(url, collection, uuid(), 'integer');
				const ws = common.createWebSocketConn(url, HANDSHAKE);

				try {
					await ws.subscribe({ collection, item: targetId, uid: 'item' });
					await updateItem(url, collection, targetId, uuid());
					await ws.getMessages(1, { uid: 'item' });

					const base = ws.getMessageCount('item');
					await updateItem(url, collection, otherId, uuid());
					const targetName = uuid();
					await updateItem(url, collection, targetId, targetName);

					expect((await ws.getMessages(1, { uid: 'item' }))![0]).toMatchObject({
						event: 'update',
						data: [{ id: targetId, name: targetName }],
					});

					expect(ws.getMessageCount('item')).toBe(base + 1);
				} finally {
					ws.conn.close();
				}
			},
			120000
		);

		it.each(supportedVendors)(
			'%s: query scope',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const url = urlOf(vendor, envs[vendor]!.main);
				const match = `match-${uuid()}`;

				const ws = common.createWebSocketConn(url, HANDSHAKE);

				try {
					await ws.subscribe({ collection, query: { filter: { name: { _eq: match } } }, uid: 'query' });

					const matchId = await insertItem(url, collection, match, 'integer');
					await ws.getMessages(1, { uid: 'query' });

					const base = ws.getMessageCount('query');
					await insertItem(url, collection, `other-${uuid()}`, 'integer');
					const secondMatchId = await insertItem(url, collection, match, 'integer');

					expect((await ws.getMessages(1, { uid: 'query' }))![0]).toMatchObject({
						event: 'create',
						data: [{ id: secondMatchId }],
					});

					expect(ws.getMessageCount('query')).toBe(base + 1);
					expect(matchId).toBeDefined();
				} finally {
					ws.conn.close();
				}
			},
			120000
		);
	});

	describe('Owner-scoped delivery for $CURRENT_USER', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = collectionScoped;
				const url = urlOf(vendor, envs[vendor]!.main);
				const ownerId = await resolveUserId(url, realtimeUsers.owner.email);
				const foreignId = common.USER.TESTS_FLOW.ID;

				const ownerRest = common.createWebSocketConn(url, handshakeAs(realtimeUsers.owner.token));
				const ownerGql = common.createWebSocketGql(url, handshakeAs(realtimeUsers.owner.token));

				try {
					await ownerRest.subscribe({ collection });
					const ownerKey = await ownerGql.subscribe({ collection, jsonQuery: GQL_DATA });

					await insertItem(url, collection, uuid(), 'integer', { owner: ownerId });
					await ownerRest.getMessages(1);
					await ownerGql.getMessages(1);

					const restBase = ownerRest.getMessageCount();
					const gqlBase = ownerGql.getMessageCount();

					await insertItem(url, collection, uuid(), 'integer', { owner: foreignId });
					const ownedName = uuid();
					const ownedId = await insertItem(url, collection, ownedName, 'integer', { owner: ownerId });

					expect((await ownerRest.getMessages(1))![0]).toMatchObject({ event: 'create', data: [{ id: ownedId }] });
					expect(ownerRest.getMessageCount()).toBe(restBase + 1);

					expect((await ownerGql.getMessages(1))![0]).toMatchObject({
						data: { [ownerKey]: { event: 'create', data: { id: String(ownedId), name: ownedName } } },
					});

					expect(ownerGql.getMessageCount()).toBe(gqlBase + 1);
				} finally {
					ownerRest.conn.close();
					await ownerGql.client.dispose();
				}
			},
			120000
		);
	});

	describe('GraphQL validation gate', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const url = urlOf(vendor, envs[vendor]!.gate);

				const frames: any[] = [];

				const gql = common.createWebSocketGql(url, {
					...HANDSHAKE,
					client: {
						url: `ws://${url.split('//')[1]}/graphql`,
						on: {
							opened: (socket: any) => {
								socket.on('message', (data: any) => frames.push(JSON.parse(data.toString())));
							},
						},
					},
				});

				const errorFor = (id: string) => frames.find((frame) => frame.type === 'error' && frame.id === id);

				try {
					await gql.subscribe({ collection, jsonQuery: { event: true }, uid: 'valid' });
					await insertItem(url, collection, uuid(), 'integer');

					expect((await gql.getMessages(1, { uid: 'valid' }))![0]).toMatchObject({
						data: { [`${collection}_mutated`]: { event: 'create' } },
					});

					await gql.sendRaw({
						id: 'introspection',
						type: 'subscribe',
						payload: { query: 'query { __schema { queryType { name } } }' },
					});

					await waitUntil(() => errorFor('introspection') !== undefined);
					expect(JSON.stringify(errorFor('introspection'))).toMatch(/introspection/i);

					await gql.sendRaw({
						id: 'over',
						type: 'subscribe',
						payload: {
							query: `subscription { ${collection}_mutated { a:event b:event c:event d:event e:event f:event g:event h:event i:event j:event } }`,
						},
					});

					await waitUntil(() => errorFor('over') !== undefined);
					expect(JSON.stringify(errorFor('over'))).toMatch(/token/i);
				} finally {
					await gql.client.dispose();
				}
			},
			120000
		);
	});

	describe('Cross-instance GraphQL delete feed', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = collectionScoped;
				const { main, peer } = envs[vendor]!;
				const mainUrl = urlOf(vendor, main);

				const wsGql = common.createWebSocketGql(urlOf(vendor, peer), {
					...STRICT,
					auth: { access_token: realtimeUsers.readerAll.token },
				});

				try {
					const key = await wsGql.subscribe({ collection, event: 'delete', jsonQuery: GQL_DELETE });

					const primeId = await insertItem(mainUrl, collection, uuid(), 'integer');
					await deleteItem(mainUrl, collection, primeId);
					await wsGql.getMessages(1);

					const targetId = await insertItem(mainUrl, collection, uuid(), 'integer');
					await deleteItem(mainUrl, collection, targetId);

					expect((await wsGql.getMessages(1))![0]).toEqual({
						data: { [key]: { event: 'delete', key: String(targetId), data: null } },
					});
				} finally {
					await wsGql.client.dispose();
				}
			},
			120000
		);
	});

	describe('Malformed frame handling', () => {
		it.each(supportedVendors)(
			'%s: REST survives',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const url = urlOf(vendor, envs[vendor]!.main);
				const ws = common.createWebSocketConn(url, HANDSHAKE);

				try {
					await ws.subscribe({ collection, uid: 'live' });
					ws.conn.send('not json');

					expect((await ws.getMessages(1))![0]).toMatchObject({
						status: 'error',
						error: { code: 'INVALID_PAYLOAD' },
					});

					await insertItem(url, collection, uuid(), 'integer');
					expect((await ws.getMessages(1, { uid: 'live' }))![0]).toMatchObject({ event: 'create' });
				} finally {
					ws.conn.close();
				}
			},
			120000
		);

		it.each(supportedVendors)(
			'%s: GraphQL closes 4400',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const url = urlOf(vendor, envs[vendor]!.main);

				let rawSocket: any;
				let resolveClosed!: (code: number) => void;

				const closed = new Promise<number>((resolve) => {
					resolveClosed = resolve;
				});

				const wsGql = common.createWebSocketGql(url, {
					...HANDSHAKE,
					client: {
						url: `ws://${url.split('//')[1]}/graphql`,
						on: {
							opened: (socket: unknown) => {
								rawSocket = socket;
							},
							closed: (...args: any[]) => {
								const event = args[0];
								resolveClosed(typeof event === 'number' ? event : event?.code);
							},
						},
					},
				});

				try {
					await wsGql.subscribe({ collection, jsonQuery: GQL_DATA });
					rawSocket.send('not json');

					expect(await closed).toBe(4400);
				} finally {
					await wsGql.client.dispose();
				}
			},
			120000
		);
	});

	describe('Strict upgrade contract', () => {
		function rawUpgrade(
			peerUrl: string,
			options: { headers?: Record<string, string>; origin?: string; queryToken?: string }
		): Promise<{ opened: boolean; status?: number; body: string }> {
			const query = options.queryToken ? `?access_token=${options.queryToken}` : '';

			return new Promise((resolve, reject) => {
				let settled = false;
				let responseStatus: number | undefined;

				const socket = new WsImpl(`ws://${peerUrl.split('//')[1]}/websocket${query}`, {
					headers: options.headers,
					origin: options.origin,
				});

				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					socket.terminate();
					reject(new Error('upgrade did not settle'));
				}, 5000);

				const finish = (action: () => void) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					action();
				};

				socket.on('open', () =>
					finish(() => {
						socket.close();
						resolve({ opened: true, body: '' });
					})
				);

				socket.on('unexpected-response', (_request, response) => {
					responseStatus = response.statusCode;
					let body = '';

					response.on('data', (chunk: Buffer) => {
						body += chunk.toString();
					});

					const done = () => finish(() => resolve({ opened: false, status: responseStatus, body }));
					response.on('end', done);
					response.on('close', done);
				});

				socket.on('error', (error) => {
					if (responseStatus !== undefined) return;
					finish(() => reject(error));
				});
			});
		}

		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const peerUrl = urlOf(vendor, envs[vendor]!.peer);
				const origin = peerUrl;
				const bearer = { Authorization: `Bearer ${TOKEN}` };

				const accepted = await rawUpgrade(peerUrl, { headers: bearer, origin });
				expect(accepted.opened).toBe(true);

				const rejections = [
					{ options: { origin }, status: 401 },
					{ options: { headers: { Authorization: 'Bearer wrong' }, origin }, status: 401 },
					{ options: { queryToken: TOKEN, origin }, status: 400 },
					{ options: { headers: bearer, origin: 'http://disallowed.invalid' }, status: 403 },
				];

				for (const rejection of rejections) {
					const result = await rawUpgrade(peerUrl, rejection.options);
					expect(result.opened).toBe(false);
					expect(result.status).toBe(rejection.status);
					expect(result.body).toBe('');
				}

				const login = await request(peerUrl)
					.post('/auth/login')
					.send({ email: common.USER.ADMIN.EMAIL, password: common.USER.ADMIN.PASSWORD, mode: 'cookie' });

				expect(login.statusCode).toBe(200);
				const setCookie = login.headers['set-cookie'] as unknown as string[] | undefined;

				const refreshCookie = setCookie?.find((entry) => entry.startsWith(`${common.REFRESH_TOKEN_COOKIE_NAME}=`));

				expect(refreshCookie).toBeDefined();

				const cookieOnly = await rawUpgrade(peerUrl, { headers: { Cookie: refreshCookie!.split(';')[0] }, origin });
				expect(cookieOnly.opened).toBe(false);
				expect(cookieOnly.status).toBe(401);
				expect(cookieOnly.body).toBe('');
			},
			120000
		);
	});

	describe('SDK realtime workflow', () => {
		it.each(supportedVendors)(
			'%s',
			async (vendor) => {
				const collection = `${collectionFirst}_integer`;
				const url = urlOf(vendor, envs[vendor]!.main);

				const client = createCairnCMS(url, { globals: { WebSocket: WsImpl as any } })
					.with(staticToken(TOKEN))
					.with(realtime({ authMode: 'handshake' }));

				const nextClose = () =>
					new Promise<void>((resolve, reject) => {
						let settled = false;
						let off: () => void = () => undefined;

						const timer = setTimeout(() => {
							if (settled) return;
							settled = true;
							off();
							reject(new Error('Timed out waiting for close'));
						}, 5000);

						off = client.onWebSocket('close', () => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							off();
							resolve();
						});
					});

				const watermark = common.createWebSocketConn(url, HANDSHAKE);
				let active: { unsubscribe(): void } | undefined;

				try {
					await client.connect();

					const first = await client.subscribe(collection as never);
					active = first;

					const init1 = await withDeadline(first.subscription.next(), 'first init');
					expect(init1.done).toBe(false);
					expect(init1.value).toMatchObject({ type: 'subscription', event: 'init' });

					const name1 = uuid();
					const id1 = await insertItem(url, collection, name1, 'integer');

					expect((await withDeadline(first.subscription.next(), 'first create')).value).toMatchObject({
						event: 'create',
						data: [{ id: id1, name: name1 }],
					});

					first.unsubscribe();
					active = undefined;
					const closed1 = nextClose();
					client.disconnect();
					await closed1;
					expect(await client.isConnected()).toBe(false);

					await client.connect();

					const second = await client.subscribe(collection as never);
					active = second;

					const init2 = await withDeadline(second.subscription.next(), 'second init');
					expect(init2.done).toBe(false);
					expect(init2.value).toMatchObject({ type: 'subscription', event: 'init' });

					const name2 = uuid();
					const id2 = await insertItem(url, collection, name2, 'integer');

					expect((await withDeadline(second.subscription.next(), 'second create')).value).toMatchObject({
						event: 'create',
						data: [{ id: id2, name: name2 }],
					});

					await watermark.subscribe({ collection, uid: 'wm' });

					let sdkMessages = 0;

					const offMessage = client.onWebSocket('message', () => {
						sdkMessages++;
					});

					const baseline = sdkMessages;
					const closed2 = nextClose();
					client.disconnect();
					await closed2;

					const id3 = await insertItem(url, collection, uuid(), 'integer');

					expect((await watermark.getMessages(1, { uid: 'wm' }))![0]).toMatchObject({
						type: 'subscription',
						event: 'create',
						data: [{ id: id3 }],
					});

					expect(sdkMessages).toBe(baseline);
					expect(await client.isConnected()).toBe(false);
					offMessage();
				} finally {
					active?.unsubscribe();
					client.disconnect();
					watermark.conn.close();
				}
			},
			120000
		);
	});
});
