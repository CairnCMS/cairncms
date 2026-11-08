import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createWebSocketGql } from '../../routes/realtime/transport';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const forbidden = [{ message: "You don't have permission to access this.", extensions: { code: 'FORBIDDEN' } }];
const subscription = { collection: 'fixture', uid: 'fixture', jsonQuery: { event: true } };
let server: WebSocketServer;
let host: string;
let transport: ReturnType<typeof createWebSocketGql> | undefined;

beforeEach(async () => {
	server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	vi.useRealTimers();
	await transport?.client.dispose();
	transport = undefined;
	for (const socket of server.clients) socket.terminate();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

for (const type of ['error', 'complete'] as const) {
	test(`retains an immediate subscription ${type} after the connection closes`, async () => {
		server.on('connection', (socket) => {
			socket.on('message', (data) => {
				const message = JSON.parse(data.toString());
				if (message.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
				if (message.type === 'subscribe')
					socket.send(JSON.stringify({ type, id: message.id, ...(type === 'error' ? { payload: forbidden } : {}) }));
			});
		});

		// Hold polling timers until the real protocol exchange has closed the socket.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		let closed!: () => void;
		const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
		transport = createWebSocketGql(host, { client: { url: host, retryAttempts: 0, on: { closed } } });

		const outcome = transport.subscribe(subscription).then(
			(key) => ({ key }),
			(error: unknown) => ({ error })
		);

		await connectionClosed;
		await vi.advanceTimersByTimeAsync(5005);
		expect(await outcome).toEqual({ key: 'fixture_mutated' });
		vi.useRealTimers();
		if (type === 'error') expect(await transport.waitForError({ uid: 'fixture' })).toEqual(forbidden);
		else expect(transport.isCompleted('fixture')).toBe(true);
	});
}

test('delivers subscription data and preserves caller connection callbacks', async () => {
	const payload = { data: { fixture_mutated: { event: 'create' } } };

	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
			if (message.type === 'subscribe') socket.send(JSON.stringify({ type: 'next', id: message.id, payload }));
		});
	});

	const opened = vi.fn();
	const connected = vi.fn();
	let closed!: () => void;
	const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
	transport = createWebSocketGql(host, { client: { url: host, on: { opened, connected, closed } } });
	expect(await transport.subscribe(subscription)).toBe('fixture_mutated');
	expect(await transport.getMessages(1, { uid: 'fixture' })).toEqual([payload]);
	expect(opened).toHaveBeenCalledOnce();
	expect(connected).toHaveBeenCalledOnce();
	transport.unsubscribe('fixture');
	await connectionClosed;
});

test('reports a connection rejection before acknowledgement', async () => {
	server.on('connection', (socket) => socket.close(4403, 'Forbidden'));
	transport = createWebSocketGql(host, { client: { url: host, retryAttempts: 0 } });
	await expect(transport.subscribe(subscription)).rejects.toMatchObject({ code: 4403, reason: 'Forbidden' });
});

test('cleans up a synchronous subscription failure before another attempt', async () => {
	const payload = { data: { fixture_mutated: { event: 'create' } } };

	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
			if (message.type === 'subscribe') socket.send(JSON.stringify({ type: 'next', id: message.id, payload }));
		});
	});

	const error = new Error('Operation id generation failed');

	const generateID = vi
		.fn()
		.mockImplementationOnce(() => {
			throw error;
		})
		.mockReturnValue('operation');

	transport = createWebSocketGql(host, { client: { url: host, generateID } });
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	await expect(transport.subscribe(subscription)).rejects.toBe(error);
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
	expect(await transport.subscribe(subscription)).toBe('fixture_mutated');
	expect(await transport.getMessages(1, { uid: 'fixture' })).toEqual([payload]);
});

test('fails and closes the socket when the server never acknowledges', async () => {
	let initialized!: () => void;
	const connectionInitialized = new Promise<void>((resolve) => (initialized = resolve));
	server.on('connection', (socket) => socket.on('message', () => initialized()));
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	let closed!: () => void;
	const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
	transport = createWebSocketGql(host, { client: { url: host, retryAttempts: 0, on: { closed } } });
	const outcome = transport.subscribe(subscription).catch((error: unknown) => error);
	await connectionInitialized;
	await vi.advanceTimersByTimeAsync(5005);
	expect(await outcome).toEqual(new Error('WebSocket connection acknowledgement timed out'));
	await connectionClosed;
});

test('requires acknowledgement again after reconnecting', async () => {
	let connections = 0;
	let acknowledge!: () => void;
	let initialized!: () => void;
	const secondConnectionInitialized = new Promise<void>((resolve) => (initialized = resolve));

	server.on('connection', (socket) => {
		const number = ++connections;

		socket.on('message', (data) => {
			const message = JSON.parse(data.toString());

			if (message.type === 'connection_init') {
				if (number === 1) socket.send(JSON.stringify({ type: 'connection_ack' }));
				else {
					acknowledge = () => socket.send(JSON.stringify({ type: 'connection_ack' }));
					initialized();
				}
			}

			if (message.type === 'subscribe')
				socket.send(JSON.stringify({ type: 'error', id: message.id, payload: forbidden }));
		});
	});

	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	let closed!: () => void;
	const firstConnectionClosed = new Promise<void>((resolve) => (closed = resolve));
	const connected = vi.fn();
	transport = createWebSocketGql(host, { client: { url: host, retryAttempts: 0, on: { closed, connected } } });
	const firstOutcome = transport.subscribe(subscription).catch((error: unknown) => error);
	await firstConnectionClosed;
	await vi.advanceTimersByTimeAsync(5005);
	expect(await firstOutcome).toBe('fixture_mutated');
	let settled = false;
	const secondOutcome = transport.subscribe({ ...subscription, uid: 'second' }).finally(() => (settled = true));
	await secondConnectionInitialized;
	await vi.advanceTimersByTimeAsync(10);
	expect(settled).toBe(false);
	acknowledge();
	expect(await secondOutcome).toBe('fixture_mutated');
	expect(connected).toHaveBeenCalledTimes(2);
});
