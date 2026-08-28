import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCairnCMS } from '../src/client.js';
import { realtime } from '../src/realtime/composable.js';
import { Channel } from '../src/realtime/utils/channel.js';
import { ChannelRegistry } from '../src/realtime/utils/channel-registry.js';

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

	messageRaw(data: unknown): void {
		this.emit('message', { data });
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

		ws.serverClose(1000);
		await flush();
		ws.message({ type: 'ping' });
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

	it('attaches exactly one router message listener while open and detaches it on close', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		expect(ws.listenerCount('message')).toBe(1);

		ws.serverClose(1000);
		await wait(20);

		expect(ws.listenerCount('message')).toBe(0);
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

describe('realtime channel primitive', () => {
	it('delivers queued frames in FIFO order', async () => {
		const channel = new Channel(() => undefined);
		channel.enqueue({ n: 1 }, 1);
		channel.enqueue({ n: 2 }, 1);

		expect((await channel.next()).value).toEqual({ n: 1 });
		expect((await channel.next()).value).toEqual({ n: 2 });
	});

	it('resolves concurrent pulls in call order', async () => {
		const channel = new Channel(() => undefined);
		const first = channel.next();
		const second = channel.next();

		channel.tryHandoff({ n: 1 });
		channel.tryHandoff({ n: 2 });

		expect((await first).value).toEqual({ n: 1 });
		expect((await second).value).toEqual({ n: 2 });
	});

	it('closes to a done result for pending and future pulls', async () => {
		const channel = new Channel(() => undefined);
		const pending = channel.next();
		channel.close();

		expect(await pending).toEqual({ value: undefined, done: true });
		expect(await channel.next()).toEqual({ value: undefined, done: true });
	});

	it('fails to a rejection for pending and future pulls', async () => {
		const channel = new Channel(() => undefined);
		const pending = channel.next();
		const error = new Error('boom');
		channel.fail(error);

		await expect(pending).rejects.toBe(error);
		await expect(channel.next()).rejects.toBe(error);
	});

	it('settles terminally only once', async () => {
		const channel = new Channel(() => undefined);
		const error = new Error('boom');
		channel.fail(error);
		channel.close();

		await expect(channel.next()).rejects.toBe(error);
	});
});

describe('realtime channel registry', () => {
	it('does not count a frame handed directly to a waiting pull', async () => {
		let overflowed = false;
		const registry = new ChannelRegistry(() => (overflowed = true), 1, 1_000_000);
		const channel = registry.create('a');

		const pull = channel.next();
		registry.route('a', { n: 1 }, 10);
		await pull;

		registry.route('a', { n: 2 }, 10);
		expect(overflowed).toBe(false);
	});

	it('releases a drained frame so the budget frees up', async () => {
		let overflowed = false;
		const registry = new ChannelRegistry(() => (overflowed = true), 1, 1_000_000);
		const channel = registry.create('a');

		registry.route('a', { n: 1 }, 10);
		await channel.next();
		registry.route('a', { n: 2 }, 10);

		expect(overflowed).toBe(false);
	});

	it('consumes nothing when routing to an unknown uid', () => {
		let overflowed = false;
		const registry = new ChannelRegistry(() => (overflowed = true), 1, 1_000_000);
		registry.create('a');

		registry.route('missing', { n: 1 }, 10);
		registry.route('a', { n: 1 }, 10);

		expect(overflowed).toBe(false);
	});

	it('overflows on the frame after the count bound and fails every channel', async () => {
		let overflow: Error | null = null;
		const registry = new ChannelRegistry((error) => (overflow = error), 2, 1_000_000);
		const a = registry.create('a');
		const b = registry.create('b');

		registry.route('a', { n: 1 }, 10);
		registry.route('a', { n: 2 }, 10);
		expect(overflow).toBeNull();

		registry.route('b', { n: 3 }, 10);
		expect(overflow).toBeInstanceOf(Error);
		await expect(a.next()).rejects.toBe(overflow);
		await expect(b.next()).rejects.toBe(overflow);
	});

	it('bounds the byte budget using the serialized byte size of a non-ASCII frame', () => {
		let overflow: Error | null = null;
		const size = new TextEncoder().encode(JSON.stringify({ title: 'cafe mañana' })).byteLength;
		const registry = new ChannelRegistry((error) => (overflow = error), 1000, size);
		registry.create('a');

		registry.route('a', { n: 1 }, size);
		expect(overflow).toBeNull();

		registry.route('a', { n: 2 }, 1);
		expect(overflow).toBeInstanceOf(Error);
	});

	it('releases retained frames when a channel is deleted so the budget recovers', () => {
		let overflow: Error | null = null;
		const registry = new ChannelRegistry((error) => (overflow = error), 2, 1_000_000);
		const a = registry.create('a');
		registry.route('a', { n: 1 }, 10);
		registry.route('a', { n: 2 }, 10);

		registry.delete('a', a);

		registry.create('b');
		registry.route('b', { n: 3 }, 10);
		registry.route('b', { n: 4 }, 10);
		expect(overflow).toBeNull();
	});

	it('rejects a duplicate uid at the registry boundary', () => {
		const registry = new ChannelRegistry(() => undefined);
		registry.create('a');
		expect(() => registry.create('a')).toThrow();
	});
});

describe('realtime SDK channel ingress', () => {
	function subscribeFrame(ws: MockWebSocket) {
		return ws
			.messages()
			.filter((m) => m.type === 'subscribe')
			.pop();
	}

	it('delivers an init frame that arrives before the first next()', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never);
		const sub = subscribeFrame(ws);

		ws.message({ type: 'subscription', uid: sub.uid, event: 'init', data: [{ id: 1 }] });

		const result = await subscription[Symbol.asyncIterator]().next();
		expect(result.value).toMatchObject({ type: 'subscription', event: 'init' });
	});

	it('retains events delivered while the consumer is paused, in order', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never);
		const sub = subscribeFrame(ws);
		const it = subscription[Symbol.asyncIterator]();

		ws.message({ type: 'subscription', uid: sub.uid, event: 'create', data: [{ id: 1 }] });
		ws.message({ type: 'subscription', uid: sub.uid, event: 'update', data: [{ id: 1 }] });

		expect((await it.next()).value).toMatchObject({ event: 'create' });
		expect((await it.next()).value).toMatchObject({ event: 'update' });
	});

	it('rejects a subscription whose targeted error arrives before any pull', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never);
		const sub = subscribeFrame(ws);

		ws.message({ type: 'subscribe', status: 'error', uid: sub.uid, error: { code: 'X', message: 'nope' } });

		await expect(subscription[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 'error' });
	});

	it('isolates delivery between two simultaneous subscriptions', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const a = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const b = await client.subscribe('articles' as never, { uid: 'b' } as never);

		ws.message({ type: 'subscription', uid: 'b', event: 'create', data: [{ id: 2 }] });
		ws.message({ type: 'subscription', uid: 'a', event: 'create', data: [{ id: 1 }] });

		expect((await a.subscription[Symbol.asyncIterator]().next()).value).toMatchObject({ data: [{ id: 1 }] });
		expect((await b.subscription[Symbol.asyncIterator]().next()).value).toMatchObject({ data: [{ id: 2 }] });
	});

	it('resolves two concurrent pulls in frame order', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never);
		const sub = subscribeFrame(ws);
		const it = subscription[Symbol.asyncIterator]();

		const first = it.next();
		const second = it.next();

		ws.message({ type: 'subscription', uid: sub.uid, event: 'create', data: [{ id: 1 }] });
		ws.message({ type: 'subscription', uid: sub.uid, event: 'update', data: [{ id: 2 }] });

		expect((await first).value).toMatchObject({ event: 'create' });
		expect((await second).value).toMatchObject({ event: 'update' });
	});

	it('sends exactly one unsubscribe on return() and leaves a sibling running', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const a = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const b = await client.subscribe('articles' as never, { uid: 'b' } as never);

		await a.subscription[Symbol.asyncIterator]().return();

		const unsubs = ws.messages().filter((m) => m.type === 'unsubscribe' && m.uid === 'a');
		expect(unsubs).toHaveLength(1);

		ws.message({ type: 'subscription', uid: 'b', event: 'create', data: [{ id: 2 }] });
		expect((await b.subscription[Symbol.asyncIterator]().next()).value).toMatchObject({ event: 'create' });
	});

	it('rejects with the injected error on throw() and unblocks a pending pull', async () => {
		const client = makeClient({ authMode: 'public' });
		await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const it = subscription[Symbol.asyncIterator]();
		const pending = it.next();

		const error = new Error('consumer abort');
		await expect(it.throw(error)).rejects.toBe(error);
		await expect(pending).rejects.toBe(error);
	});

	it('routes a synchronous subscribe response to the owning channel', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const realSend = ws.send.bind(ws);

		vi.spyOn(ws, 'send').mockImplementation((raw: string) => {
			realSend(raw);
			const parsed = JSON.parse(raw);

			if (parsed.type === 'subscribe') {
				ws.message({ type: 'subscription', uid: parsed.uid, event: 'init', data: [{ id: 9 }] });
			}
		});

		const { subscription } = await client.subscribe('articles' as never);
		const result = await subscription[Symbol.asyncIterator]().next();
		expect(result.value).toMatchObject({ event: 'init', data: [{ id: 9 }] });
	});

	it('normalizes omitted and explicit-undefined uids and rejects empty or non-string ones', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		await client.subscribe('articles' as never);
		expect(typeof subscribeFrame(ws).uid).toBe('string');

		await client.subscribe('articles' as never, { uid: undefined } as never);
		expect(subscribeFrame(ws).uid).not.toBe('undefined');

		await expect(client.subscribe('articles' as never, { uid: '' } as never)).rejects.toThrow();
		await expect(client.subscribe('articles' as never, { uid: 5 } as never)).rejects.toThrow();
	});

	it('skips an active explicit uid when generating', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		await client.subscribe('articles' as never, { uid: '1' } as never);
		await client.subscribe('articles' as never);

		const uids = ws
			.messages()
			.filter((m) => m.type === 'subscribe')
			.map((m) => m.uid);

		expect(uids).toContain('1');
		expect(new Set(uids).size).toBe(uids.length);
	});

	it('does not mutate the caller-supplied options object', async () => {
		const client = makeClient({ authMode: 'public' });
		await openPublic(client);

		const options = { query: { fields: ['id'] } } as any;
		await client.subscribe('articles' as never, options);

		expect('uid' in options).toBe(false);
		expect(options.query).toEqual({ fields: ['id'] });
	});

	it('routes non-object and malformed frames to generic callbacks without shape routing', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const received: any[] = [];
		client.onWebSocket('message', (m) => received.push(m));

		ws.message('null');
		ws.message('[1,2,3]');
		ws.message('42');
		ws.message('not json{');
		await flush();

		expect(received).toContainEqual([1, 2, 3]);
		expect(received).toContain(42);
	});

	it('completes the handshake when the auth ack arrives synchronously during send', async () => {
		const client = makeClient({ authMode: 'handshake' }, 'token-1');
		const connecting = client.connect();
		await flush();
		const ws = MockWebSocket.last();

		const realSend = ws.send.bind(ws);

		vi.spyOn(ws, 'send').mockImplementation((raw: string) => {
			realSend(raw);
			if (JSON.parse(raw).type === 'auth') ws.message({ type: 'auth', status: 'ok' });
		});

		ws.open();
		await connecting;
		expect(await client.isConnected()).toBe(true);
	});

	it('fails every subscription and tears down the socket on receive-buffer overflow', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const it = subscription[Symbol.asyncIterator]();

		for (let i = 0; i <= 1000; i++) {
			ws.message({ type: 'subscription', uid: 'a', event: 'create', data: [{ id: i }] });
		}

		await flush();

		await expect(it.next()).rejects.toBeInstanceOf(Error);
		expect(ws.closed).toBe(true);

		const reconnecting = client.connect();
		await flush();
		MockWebSocket.last().open();
		await reconnecting;
		expect(await client.isConnected()).toBe(true);
	});

	it('rejects one of two subscriptions that reserve the same explicit uid before open', async () => {
		const client = makeClient({ authMode: 'public' });

		const first = client.subscribe('articles' as never, { uid: 'dup' } as never);
		const second = client.subscribe('articles' as never, { uid: 'dup' } as never);

		await flush();
		MockWebSocket.last().open();

		const results = await Promise.allSettled([first, second]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
	});

	it('forwards a successful auth acknowledgement to generic message callbacks', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const received: any[] = [];
		client.onWebSocket('message', (m) => received.push(m));

		ws.message({ type: 'auth', status: 'ok' });
		await flush();

		expect(received).toContainEqual({ type: 'auth', status: 'ok' });
	});

	it('does not route a non-string subscription-shaped frame to its channel', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const { subscription } = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const it = subscription[Symbol.asyncIterator]();

		ws.messageRaw({ type: 'subscription', uid: 'a', event: 'create', data: [{ id: 99 }] });
		ws.message({ type: 'subscription', uid: 'a', event: 'create', data: [{ id: 1 }] });

		const result = await it.next();
		expect(result.value).toMatchObject({ data: [{ id: 1 }] });
	});

	it('does not let a stale iterator delete a successor that reused its uid', async () => {
		const client = makeClient({ authMode: 'public' });
		const ws = await openPublic(client);

		const old = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const oldIt = old.subscription[Symbol.asyncIterator]();

		ws.message({ type: 'subscribe', status: 'error', uid: 'a', error: { code: 'X', message: 'nope' } });
		await expect(oldIt.next()).rejects.toMatchObject({ status: 'error' });

		const successor = await client.subscribe('articles' as never, { uid: 'a' } as never);
		const successorIt = successor.subscription[Symbol.asyncIterator]();

		const before = ws.messages().filter((m) => m.type === 'unsubscribe' && m.uid === 'a').length;

		await oldIt.return();
		old.unsubscribe();

		const after = ws.messages().filter((m) => m.type === 'unsubscribe' && m.uid === 'a').length;
		expect(after).toBe(before);

		ws.message({ type: 'subscription', uid: 'a', event: 'create', data: [{ id: 7 }] });
		expect((await successorIt.next()).value).toMatchObject({ data: [{ id: 7 }] });
	});
});
