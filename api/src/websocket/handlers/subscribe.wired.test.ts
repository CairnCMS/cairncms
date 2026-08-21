import type { SchemaOverview } from '@cairncms/types';
import express from 'express';
import type { Knex } from 'knex';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Admission } from '../admission.js';
import { resolveTargetService } from '../target.js';
import { getInitialPayload } from '../utils/items.js';

vi.mock('../target.js', () => ({ resolveTargetService: vi.fn() }));
vi.mock('../utils/items.js', () => ({ getInitialPayload: vi.fn() }));

const { WebSocketController } = await import('../controllers/rest.js');
const { SubscriptionRegistry } = await import('../subscriptions.js');

const resolveTarget = vi.mocked(resolveTargetService);
const initialPayload = vi.mocked(getInitialPayload);

const SCHEMA = { collections: {}, relations: [] } as unknown as SchemaOverview;

const WiredController = class extends WebSocketController {
	protected override async refreshBeforeCommand(): Promise<boolean> {
		return true;
	}
};

interface Harness {
	registry: InstanceType<typeof SubscriptionRegistry>;
	connect: () => Promise<WebSocket>;
	teardown: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const registry = new SubscriptionRegistry();

	const controller = new WiredController({
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
		subscriptions: registry,
	});

	const server: Server = createServer();
	server.on('upgrade', controller.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as AddressInfo).port;

	const sockets: WebSocket[] = [];

	const connect = (): Promise<WebSocket> =>
		new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/websocket`);
			sockets.push(ws);
			ws.on('open', () => resolve(ws));
			ws.on('error', reject);
		});

	const teardown = async () => {
		for (const ws of sockets) ws.terminate();
		await controller.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { registry, connect, teardown };
}

function collect(ws: WebSocket): Record<string, any>[] {
	const frames: Record<string, any>[] = [];
	ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
	return frames;
}

function sendJson(ws: WebSocket, message: Record<string, unknown>): void {
	ws.send(JSON.stringify(message));
}

function deferred<T>() {
	let resolve!: (value: T) => void;

	const promise = new Promise<T>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

let harness: Harness | null = null;

beforeEach(() => {
	resolveTarget.mockReset();
	resolveTarget.mockReturnValue({} as never);
	initialPayload.mockReset();
	initialPayload.mockResolvedValue({ event: 'init', data: [] });
});

afterEach(async () => {
	if (harness) await harness.teardown();
	harness = null;
});

describe('subscribe command wired over the drain', () => {
	it('activates a subscription and removes it on unsubscribe', async () => {
		harness = await createHarness();
		const ws = await harness.connect();
		const frames = collect(ws);

		sendJson(ws, { type: 'subscribe', collection: 'articles', event: 'update', uid: 1 });

		await vi.waitFor(() =>
			expect(harness!.registry.getActiveByCollection('articles', Number.MAX_SAFE_INTEGER)).toHaveLength(1)
		);

		await vi.waitFor(() =>
			expect(frames.some((f) => f['type'] === 'subscription' && f['event'] === 'init')).toBe(true)
		);

		expect(frames.find((f) => f['type'] === 'subscription')).toMatchObject({ event: 'init', uid: '1' });

		sendJson(ws, { type: 'unsubscribe', uid: 1 });

		await vi.waitFor(() => expect(harness!.registry.getSubscribedOwners()).toHaveLength(0));
		await vi.waitFor(() => expect(frames.some((f) => f['event'] === 'unsubscribe')).toBe(true));
	});

	it('does not activate or send when the connection closes during the initial read', async () => {
		harness = await createHarness();
		const ws = await harness.connect();
		const frames = collect(ws);

		const read = deferred<Record<string, unknown>>();
		const called = deferred<void>();

		initialPayload.mockImplementation(() => {
			called.resolve();
			return read.promise;
		});

		sendJson(ws, { type: 'subscribe', collection: 'articles', uid: 1 });
		await called.promise;

		const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
		ws.close();
		await closed;

		await vi.waitFor(() => expect(harness!.registry.getSubscribedOwners()).toHaveLength(0));

		read.resolve({ event: 'init', data: [] });
		await flush();
		await flush();

		expect(harness!.registry.getSubscribedOwners()).toHaveLength(0);
		expect(frames.some((f) => f['type'] === 'subscription' && f['event'] === 'init')).toBe(false);
	});
});
