import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCairnCMS } from '../src/client.js';
import { realtime } from '../src/realtime/composable.js';
import { messageCallback } from '../src/realtime/utils/message-callback.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MAX_TIMER_DELAY = 2_147_483_647;
const MAX_RECONNECT_DELAY = Math.floor(MAX_TIMER_DELAY / 2);

class MockWebSocket {
	static instances: MockWebSocket[] = [];

	static last(): MockWebSocket {
		return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
	}

	static reset(): void {
		MockWebSocket.instances = [];
	}

	readyState = 0;
	url: string;
	sent: string[] = [];
	private listeners: Record<string, Set<(ev: any) => void>> = {
		open: new Set(),
		message: new Set(),
		error: new Set(),
		close: new Set(),
	};

	private isClosed = false;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	get closed(): boolean {
		return this.isClosed;
	}

	addEventListener(type: string, cb: (ev: any) => void): void {
		(this.listeners[type] ??= new Set()).add(cb);
	}

	removeEventListener(type: string, cb: (ev: any) => void): void {
		this.listeners[type]?.delete(cb);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.readyState = 3;
		this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
	}

	private emit(type: string, ev: any): void {
		for (const cb of [...(this.listeners[type] ?? [])]) cb.call(this, ev);
	}

	// test drivers
	open(): void {
		this.readyState = 1;
		this.emit('open', {});
	}

	message(payload: unknown): void {
		this.emit('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
	}

	serverClose(code: number, reason = ''): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.readyState = 3;
		this.emit('close', { code, reason });
	}

	messages(): any[] {
		return this.sent.map((raw) => {
			try {
				return JSON.parse(raw);
			} catch {
				return raw;
			}
		});
	}

	listenerCount(type: string): number {
		return this.listeners[type]?.size ?? 0;
	}
}

const clients: Array<ReturnType<typeof makeClient>> = [];

function track<T>(client: T): T {
	clients.push(client as never);
	return client;
}

function makeClient(config: Parameters<typeof realtime>[0] = {}, token: string | null = 'test-token') {
	return track(
		createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
			.with(() => ({ getToken: async () => token }))
			.with(realtime(config))
	);
}

async function openPublic(client: ReturnType<typeof makeClient>): Promise<MockWebSocket> {
	const connecting = client.connect();
	await flush();
	const ws = MockWebSocket.last();
	ws.open();
	await connecting;
	return ws;
}

async function openHandshake(client: ReturnType<typeof makeClient>): Promise<MockWebSocket> {
	const connecting = client.connect();
	await flush();
	const ws = MockWebSocket.last();
	ws.open();
	await flush();
	ws.message({ type: 'auth', status: 'ok' });
	await connecting;
	return ws;
}

async function waitForSocketCount(count: number, tries = 200): Promise<MockWebSocket> {
	for (let i = 0; i < tries; i++) {
		if (MockWebSocket.instances.length >= count) return MockWebSocket.last();
		await wait(10);
	}

	throw new Error(`timed out waiting for ${count} sockets, saw ${MockWebSocket.instances.length}`);
}

function trackUnhandledRejections() {
	const seen: unknown[] = [];
	const handler = (reason: unknown) => seen.push(reason);
	process.on('unhandledRejection', handler);
	return { seen, stop: () => process.off('unhandledRejection', handler) };
}

beforeEach(() => MockWebSocket.reset());

afterEach(async () => {
	for (const client of clients) {
		try {
			client.disconnect();
		} catch {
			/* ignore teardown errors */
		}
	}

	clients.length = 0;
	await flush();

	for (const ws of MockWebSocket.instances) {
		if (!ws.closed) ws.close();
	}

	vi.restoreAllMocks();
	MockWebSocket.reset();
});

describe('realtime composable lifecycle', () => {
	it('connects with a handshake, sends the token, and reports connected', async () => {
		const client = makeClient({ authMode: 'handshake' });
		const ws = await openHandshake(client);

		expect(await client.isConnected()).toBe(true);
		expect(ws.messages().some((m) => m.type === 'auth' && m.access_token === 'test-token')).toBe(true);
	});

	it('delivers subscription messages to the async generator', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never);
		const sub = ws.messages().find((m) => m.type === 'subscribe');
		expect(sub).toBeTruthy();

		const next = subscription[Symbol.asyncIterator]().next();
		ws.message({ type: 'subscription', uid: sub.uid, event: 'create', data: [{ id: 1 }] });

		const result = await next;
		expect(result.value).toMatchObject({ type: 'subscription', event: 'create' });
	});

	it('serializes nested subscription fields to dot syntax on the wire', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		await client.subscribe('articles' as never, { query: { fields: [{ author: ['name'] }, 'title'] } } as never);

		const sub = ws.messages().find((m) => m.type === 'subscribe');
		expect(sub.query.fields).toContain('author.name');
		expect(sub.query.fields).toContain('title');
	});

	it('is usable again after a manual disconnect', async () => {
		const client = makeClient({ authMode: 'public' });
		await openPublic(client);
		expect(await client.isConnected()).toBe(true);

		client.disconnect();
		await flush();
		expect(await client.isConnected()).toBe(false);

		await openPublic(client);
		expect(await client.isConnected()).toBe(true);
	});

	it('tears down a connection that is still in setup when disconnect is called', async () => {
		const client = makeClient({ authMode: 'public' });

		const connecting = client.connect();
		await flush();
		const connectingSocket = MockWebSocket.last();

		client.disconnect();

		await expect(connecting).rejects.toBeDefined();
		expect(connectingSocket.closed).toBe(true);
		expect(await client.isConnected()).toBe(false);

		// a late open on the abandoned socket must not resurrect the connection
		connectingSocket.open();
		await flush();
		expect(await client.isConnected()).toBe(false);

		await openPublic(client);
		expect(await client.isConnected()).toBe(true);
	});

	it('leaves the client retryable and ignores a late open after a connect timeout', async () => {
		const client = makeClient({ authMode: 'public', connect: { timeout: 20 } });

		const connecting = client.connect();
		await flush();
		const timedOut = MockWebSocket.last();

		await expect(connecting).rejects.toBeDefined();
		expect(await client.isConnected()).toBe(false);

		timedOut.open();
		await flush();
		expect(await client.isConnected()).toBe(false);

		await openPublic(client);
		expect(await client.isConnected()).toBe(true);
	});

	it('tears down cleanly when handshake mode has no authentication composable', async () => {
		const client = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } }).with(
				realtime({ authMode: 'handshake' })
			)
		);

		const rejections = trackUnhandledRejections();
		const connecting = client.connect();
		await flush();
		const ws = MockWebSocket.last();
		ws.open();

		await expect(connecting).rejects.toBeDefined();
		expect(ws.closed).toBe(true);
		expect(await client.isConnected()).toBe(false);

		await wait(20);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('tears down without an unhandled rejection when getToken throws during the handshake', async () => {
		const client = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
				.with(() => ({
					getToken: async () => {
						throw new Error('token source failed');
					},
				}))
				.with(realtime({ authMode: 'handshake' }))
		);

		const rejections = trackUnhandledRejections();
		const connecting = client.connect();
		await flush();
		MockWebSocket.last().open();

		await expect(connecting).rejects.toBeDefined();
		expect(await client.isConnected()).toBe(false);

		await wait(20);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('rejects cleanly without an unhandled rejection when the socket closes during the handshake', async () => {
		const client = makeClient({ authMode: 'handshake' });

		const rejections = trackUnhandledRejections();
		const connecting = client.connect();
		await flush();
		const ws = MockWebSocket.last();
		ws.open();
		await flush();
		ws.serverClose(1006); // closed before the auth confirmation arrives

		await expect(connecting).rejects.toBeDefined();
		expect(await client.isConnected()).toBe(false);

		await wait(20);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('replies to a ping with a pong while open', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		ws.message({ type: 'ping' });
		await flush();

		expect(ws.messages().some((m) => m.type === 'pong')).toBe(true);
	});

	it('does not pong or throw for a ping delivered after the connection has closed', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const rejections = trackUnhandledRejections();

		// deliver a ping and close in the same tick, before the message loop processes the ping
		ws.message({ type: 'ping' });
		ws.serverClose(1000);
		await wait(20);

		expect(ws.messages().some((m) => m.type === 'pong')).toBe(false);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('does not reconnect by default when the connection closes', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const before = MockWebSocket.instances.length;
		ws.serverClose(1000);
		await wait(20);

		expect(MockWebSocket.instances.length).toBe(before);
		expect(await client.isConnected()).toBe(false);
	});

	it('exposes overload and policy close codes through onWebSocket', async () => {
		const client = makeClient({ authMode: 'public' });
		const codes: number[] = [];
		client.onWebSocket('close', (ev) => codes.push(ev.code));

		const first = await openPublic(client);
		first.serverClose(1013); // try again later
		await flush();

		const second = await openPublic(client);
		second.serverClose(1009); // message too big
		await flush();

		expect(codes).toContain(1013);
		expect(codes).toContain(1009);
	});

	it('does not replay an unsubscribed collection after a reconnect', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 3 } });
		const ws1 = await openPublic(client);

		const { unsubscribe } = await client.subscribe('articles' as never);
		unsubscribe();
		await flush();

		ws1.serverClose(1000);

		const ws2 = await waitForSocketCount(2);
		expect(ws2).not.toBe(ws1);
		ws2.open();
		await wait(20);

		expect(ws2.messages().some((m) => m.type === 'subscribe')).toBe(false);
	});

	it('replays each active subscription exactly once on reconnect', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 3 } });
		const ws1 = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never);
		const sub = ws1.messages().find((m) => m.type === 'subscribe');

		// a consumer awaiting the generator must not add a second replay owner
		const pending = subscription[Symbol.asyncIterator]().next();

		ws1.serverClose(1000);
		const ws2 = await waitForSocketCount(2);
		ws2.open();
		await wait(20);

		const replays = ws2.messages().filter((m) => m.type === 'subscribe' && m.uid === sub.uid);
		expect(replays).toHaveLength(1);

		void pending;
	});

	it('exhausts a bounded number of reconnect attempts under repeated authentication failure', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'handshake', reconnect: { delay: 10, retries: 2 } });
		const established = await openHandshake(client);

		established.serverClose(1000); // drop an established connection to start recovery

		const ws2 = await waitForSocketCount(2);
		ws2.open();
		await flush();
		ws2.serverClose(1008); // auth confirmation never arrives, attempt fails

		const ws3 = await waitForSocketCount(3);
		ws3.open();
		await flush();
		ws3.serverClose(1008); // second and final attempt fails

		await wait(250);
		expect(MockWebSocket.instances.length).toBe(3); // established + two bounded attempts
		expect(await client.isConnected()).toBe(false);
	});

	it('jitters the reconnect delay so independent clients do not retry in lockstep', async () => {
		const randomValues = [0.1, 0.8];
		vi.spyOn(Math, 'random').mockImplementation(() => randomValues.shift() ?? 0);

		const scheduled: number[] = [];
		const realSetTimeout = globalThis.setTimeout;

		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
			if (typeof ms === 'number' && ms >= 100 && ms < 1000) scheduled.push(ms);
			return realSetTimeout(fn, ms);
		}) as any);

		const clientA = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 1 } });
		const clientB = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 1 } });

		const wsA = await openPublic(clientA);
		const wsB = await openPublic(clientB);

		wsA.serverClose(1000);
		wsB.serverClose(1000);
		await flush();

		expect(scheduled).toHaveLength(2);
		expect(scheduled[0]).not.toBe(scheduled[1]);
	});

	it('tears down a deferred handshake without touching the socket when disconnect arrives mid-setup', async () => {
		let releaseToken!: (token: string) => void;

		const tokenPromise = new Promise<string>((resolve) => {
			releaseToken = resolve;
		});

		const client = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
				.with(() => ({ getToken: () => tokenPromise }))
				.with(realtime({ authMode: 'handshake' }))
		);

		const rejections = trackUnhandledRejections();
		const connecting = client.connect();
		await flush();
		const ws = MockWebSocket.last();
		ws.open(); // state is now open while getToken is still pending
		await flush();

		client.disconnect();
		await expect(connecting).rejects.toBeDefined();
		expect(ws.closed).toBe(true);

		releaseToken('late-token'); // the continuation must not send auth on the torn-down socket
		await wait(20);

		expect(ws.messages().some((m) => m.type === 'auth')).toBe(false);
		expect(await client.isConnected()).toBe(false);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('rejects a connect whose socket constructor throws and stays retryable', async () => {
		let ctorShouldThrow = true;

		class MaybeThrowingWebSocket extends MockWebSocket {
			constructor(url: string) {
				if (ctorShouldThrow) throw new Error('constructor blew up');
				super(url);
			}
		}

		const client = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MaybeThrowingWebSocket as any } })
				.with(() => ({ getToken: async () => 'test-token' }))
				.with(realtime({ authMode: 'public' }))
		);

		await expect(client.connect()).rejects.toThrow('constructor blew up');
		expect(MockWebSocket.instances).toHaveLength(0);
		expect(await client.isConnected()).toBe(false);

		ctorShouldThrow = false;
		const connecting = client.connect();
		await flush();
		MockWebSocket.last().open();
		await connecting;
		expect(await client.isConnected()).toBe(true);
	});

	it('contains a token-refresh failure after open without an unhandled rejection', async () => {
		let failToken = false;

		const client = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
				.with(() => ({
					getToken: async () => {
						if (failToken) throw new Error('token source is down');
						return 'test-token';
					},
				}))
				.with(realtime({ authMode: 'handshake' }))
		);

		const ws = await openHandshake(client);
		const rejections = trackUnhandledRejections();

		failToken = true;
		ws.message({ type: 'auth', status: 'error', error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
		await wait(20);

		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('keeps generated subscription uids unique across a reconnect', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 3 } });
		const ws1 = await openPublic(client);

		await client.subscribe('articles' as never);
		const firstUid = ws1.messages().find((m) => m.type === 'subscribe').uid;

		ws1.serverClose(1000);
		const ws2 = await waitForSocketCount(2);
		ws2.open();
		await wait(20);

		// a new subscription after the replay must not reuse the replayed uid
		await client.subscribe('authors' as never);

		const fresh = ws2
			.messages()
			.filter((m) => m.type === 'subscribe')
			.find((m) => m.collection === 'authors');

		expect(fresh.uid).toBeTruthy();
		expect(fresh.uid).not.toBe(firstUid);
	});

	it('rejects a second subscription that reuses an explicit uid', async () => {
		const client = makeClient({ authMode: 'public' });
		await openPublic(client);

		await client.subscribe('articles' as never, { uid: 'dup' } as never);
		await expect(client.subscribe('authors' as never, { uid: 'dup' } as never)).rejects.toThrow(/already exists/);
	});

	it('finalizes only the rejected subscription and leaves its sibling running and replayable', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 3 } });
		const ws1 = await openPublic(client);

		const a = await client.subscribe('articles' as never, { uid: 'A' } as never);
		const b = await client.subscribe('authors' as never, { uid: 'B' } as never);

		const aNext = a.subscription[Symbol.asyncIterator]().next();
		const bNext = b.subscription[Symbol.asyncIterator]().next();
		await flush();

		ws1.message({ type: 'subscribe', status: 'error', uid: 'A', error: { code: 'FORBIDDEN', message: 'no' } });
		await expect(aNext).rejects.toMatchObject({ status: 'error', uid: 'A' });

		ws1.message({ type: 'subscription', uid: 'B', event: 'create', data: [{ id: 1 }] });
		const bResult = await bNext;
		expect(bResult.value).toMatchObject({ type: 'subscription', uid: 'B' });

		// only the surviving subscription is replayed on reconnect
		ws1.serverClose(1000);
		const ws2 = await waitForSocketCount(2);
		ws2.open();
		await wait(20);

		const replayed = ws2.messages().filter((m) => m.type === 'subscribe');
		expect(replayed.some((m) => m.uid === 'B')).toBe(true);
		expect(replayed.some((m) => m.uid === 'A')).toBe(false);
	});

	it('removes messageCallback listeners when the socket closes during a pending wait', async () => {
		const ws = new MockWebSocket('ws://localhost');
		const pending = messageCallback(ws as any);

		expect(ws.listenerCount('message')).toBe(1);

		ws.serverClose(1000);
		await expect(pending).rejects.toBeUndefined();

		expect(ws.listenerCount('message')).toBe(0);
		expect(ws.listenerCount('close')).toBe(0);
		expect(ws.listenerCount('error')).toBe(0);
	});

	it('keeps the message pump alive after a malformed auth-shaped frame', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const received: any[] = [];
		client.onWebSocket('message', (m) => received.push(m));

		ws.message({ type: 'auth', status: 'error', error: null }); // a naive isAuthError would throw here
		await flush();
		ws.message({ type: 'subscription', uid: 'x', event: 'create', data: [] });
		await flush();

		expect(received.some((m) => m.type === 'subscription')).toBe(true);
	});

	it('resolves connect even if an open handler throws', async () => {
		const client = makeClient({ authMode: 'public' });

		client.onWebSocket('open', () => {
			throw new Error('open handler boom');
		});

		const rejections = trackUnhandledRejections();
		const connecting = client.connect();
		await flush();
		MockWebSocket.last().open();

		await expect(connecting).resolves.toBeDefined();
		expect(await client.isConnected()).toBe(true);

		await wait(20);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('cleans up and reconnects even if a close handler throws', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'public', reconnect: { delay: 10, retries: 2 } });

		client.onWebSocket('close', () => {
			throw new Error('close handler boom');
		});

		const ws1 = await openPublic(client);
		ws1.serverClose(1000);

		const ws2 = await waitForSocketCount(2);
		expect(ws2).not.toBe(ws1);
	});

	it('keeps dispatching to other message handlers after one throws or rejects', async () => {
		const client = makeClient({ authMode: 'public' });
		const received: any[] = [];

		const rejections = trackUnhandledRejections();

		client.onWebSocket('message', () => {
			throw new Error('sync handler boom');
		});

		client.onWebSocket('message', async () => {
			throw new Error('async handler boom');
		});

		client.onWebSocket('message', (m) => received.push(m));

		const ws = await openPublic(client);
		ws.message({ type: 'subscription', uid: 'x', event: 'create', data: [] });
		await flush();
		ws.message({ type: 'subscription', uid: 'y', event: 'update', data: [] });
		await flush();

		expect(received).toHaveLength(2);
		await wait(20);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('does not let one client mutate the reconnect config of another from the same factory', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const composable = realtime({ authMode: 'public', reconnect: { delay: 10, retries: 2 } });

		const clientA = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
				.with(() => ({ getToken: async () => 'token' }))
				.with(composable)
		);

		const clientB = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
				.with(() => ({ getToken: async () => 'token' }))
				.with(composable)
		);

		const wsA = await openPublic(clientA);
		// a public-mode auth failure disables reconnect, but only for client A
		wsA.message({ type: 'auth', status: 'error', error: { code: 'AUTH_TIMEOUT', message: 'x' } });
		await flush();

		const wsB = await openPublic(clientB);
		const before = MockWebSocket.instances.length;
		wsB.serverClose(1000);

		const reconnected = await waitForSocketCount(before + 1);
		expect(reconnected).toBeDefined();
	});

	it('rejects invalid reconnect and connect configuration', () => {
		expect(() => makeClient({ reconnect: { delay: 10, retries: Infinity } })).toThrow(/reconnect/);
		expect(() => makeClient({ reconnect: { delay: 10, retries: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(/reconnect/);
		expect(() => makeClient({ reconnect: { delay: Number.NaN, retries: 2 } })).toThrow(/reconnect/);
		expect(() => makeClient({ reconnect: { delay: 1e12, retries: 2 } })).toThrow(/reconnect/);
		expect(() => makeClient({ reconnect: { delay: MAX_RECONNECT_DELAY + 1, retries: 2 } })).toThrow(/reconnect/);
		expect(() => makeClient({ connect: { timeout: Number.NaN } })).toThrow(/connect/);
		expect(() => makeClient({ connect: { timeout: MAX_TIMER_DELAY + 1 } })).toThrow(/connect/);
	});

	it('accepts the maximum supported reconnect delay and connect timeout', () => {
		expect(() => makeClient({ reconnect: { delay: MAX_RECONNECT_DELAY, retries: 2 } })).not.toThrow();
		expect(() => makeClient({ connect: { timeout: MAX_TIMER_DELAY } })).not.toThrow();
	});

	it('preserves distinct jitter for large reconnect delays instead of collapsing to a clamp', async () => {
		const randomValues = [0.1, 0.8];
		vi.spyOn(Math, 'random').mockImplementation(() => randomValues.shift() ?? 0);

		const scheduled: number[] = [];
		const realSetTimeout = globalThis.setTimeout;

		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
			// capture the large reconnect backoff without scheduling a multi-day timer
			if (typeof ms === 'number' && ms > 1_000_000) {
				scheduled.push(ms);
				return 0 as any;
			}

			return realSetTimeout(fn, ms);
		}) as any);

		const clientA = makeClient({ authMode: 'public', reconnect: { delay: MAX_RECONNECT_DELAY, retries: 1 } });
		const clientB = makeClient({ authMode: 'public', reconnect: { delay: MAX_RECONNECT_DELAY, retries: 1 } });

		const wsA = await openPublic(clientA);
		const wsB = await openPublic(clientB);

		wsA.serverClose(1000);
		wsB.serverClose(1000);
		await flush();

		expect(scheduled).toHaveLength(2);
		expect(scheduled[0]).not.toBe(scheduled[1]);
	});

	it('is unaffected by later mutation of the supplied configuration', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const source = { authMode: 'public' as const, reconnect: { delay: 10, retries: 2 } };

		const client = track(
			createCairnCMS('http://localhost:8055', { globals: { WebSocket: MockWebSocket as any } })
				.with(() => ({ getToken: async () => 'token' }))
				.with(realtime(source))
		);

		// mutating the source after construction must not disable this client's recovery
		source.reconnect.retries = 0;

		const ws1 = await openPublic(client);
		ws1.serverClose(1000);
		const ws2 = await waitForSocketCount(2);
		expect(ws2).not.toBe(ws1);
	});

	it('keeps callbacks isolated even when the debug logger throws', async () => {
		const throwingLogger = {
			log: () => {
				throw new Error('log boom');
			},
			info: () => {
				throw new Error('info boom');
			},
			warn: () => {
				throw new Error('warn boom');
			},
			error: () => {
				throw new Error('error boom');
			},
		};

		vi.spyOn(Math, 'random').mockReturnValue(0);

		const client = track(
			createCairnCMS('http://localhost:8055', {
				globals: { WebSocket: MockWebSocket as any, logger: throwingLogger as any },
			})
				.with(() => ({ getToken: async () => 'token' }))
				.with(realtime({ authMode: 'public', debug: true, reconnect: { delay: 10, retries: 2 } }))
		);

		client.onWebSocket('close', () => {
			throw new Error('close handler boom');
		});

		const rejections = trackUnhandledRejections();
		const ws1 = await openPublic(client);
		ws1.serverClose(1000);

		const ws2 = await waitForSocketCount(2);
		expect(ws2).not.toBe(ws1);

		await wait(20);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('does not leak an unhandled rejection when the debug logger returns a rejected promise', async () => {
		const rejectingLogger = {
			log: () => Promise.reject(new Error('log reject')),
			info: () => Promise.reject(new Error('info reject')),
			warn: () => Promise.reject(new Error('warn reject')),
			error: () => Promise.reject(new Error('error reject')),
		};

		const client = track(
			createCairnCMS('http://localhost:8055', {
				globals: { WebSocket: MockWebSocket as any, logger: rejectingLogger as any },
			})
				.with(() => ({ getToken: async () => 'token' }))
				.with(realtime({ authMode: 'public', debug: true }))
		);

		const rejections = trackUnhandledRejections();
		const ws = await openPublic(client);
		ws.message({ type: 'ping' });
		await wait(20);

		expect(await client.isConnected()).toBe(true);
		expect(rejections.seen).toEqual([]);
		rejections.stop();
	});

	it('schedules no further backoff once disconnected during a reconnect attempt', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const client = makeClient({ authMode: 'handshake', reconnect: { delay: 10, retries: 5 } });
		const ws1 = await openHandshake(client);

		ws1.serverClose(1000);
		await waitForSocketCount(2); // attempt 1 is in flight

		let backoffTimers = 0;
		const realSetTimeout = globalThis.setTimeout;

		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
			if (typeof ms === 'number' && ms >= 100 && ms < 1000) backoffTimers++;
			return realSetTimeout(fn, ms);
		}) as any);

		client.disconnect();
		await wait(50);

		expect(backoffTimers).toBe(0);
	});
});
