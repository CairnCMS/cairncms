import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { openOrigin } from './origin.mjs';

async function listen(handler) {
	const connections = new Set();

	const server = net.createServer((socket) => {
		connections.add(socket);
		socket.once('close', () => connections.delete(socket));
		socket.on('error', () => socket.destroy());
		handler(socket);
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		async close() {
			for (const socket of connections) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

function exchange(url, bytes) {
	const address = new URL(url);
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: address.hostname, port: Number(address.port) });
		const chunks = [];
		socket.setTimeout(2000, () => socket.destroy(new Error('Control connection timed out')));
		socket.once('error', reject);
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.once('connect', () => socket.write(bytes));
		socket.once('close', () => resolve(Buffer.concat(chunks)));
	});
}

test('origin preserves request and response bytes, including upgrade traffic', { timeout: 10_000 }, async () => {
	const origin = await openOrigin();

	const sent = Buffer.concat([
		Buffer.from('GET /socket HTTP/1.1\r\nHost: example.test\r\nCookie: session=abc\r\nUpgrade: websocket\r\n\r\n'),
		Buffer.from([0, 255, 128, 17]),
	]);

	const reply = Buffer.concat([
		Buffer.from('HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: next=xyz\r\nLocation: /unchanged\r\n\r\n'),
		Buffer.from([255, 0, 17, 128]),
	]);

	let received = Buffer.alloc(0);

	const backend = await listen((socket) =>
		socket.on('data', (chunk) => {
			received = Buffer.concat([received, chunk]);
			if (received.length === sent.length) socket.end(reply);
		})
	);

	try {
		origin.connect(backend.url);
		assert.deepEqual(await exchange(origin.url, sent), reply);
		assert.deepEqual(received, sent);
	} finally {
		await origin.close();
		await backend.close();
	}
});

test('simultaneous origins own different listeners and route to their own backends', { timeout: 10_000 }, async () => {
	const origins = await Promise.all([openOrigin(), openOrigin()]);

	const backends = await Promise.all(
		['first', 'second'].map((label) => listen((socket) => socket.once('data', () => socket.end(label))))
	);

	try {
		assert.notEqual(origins[0].url, origins[1].url);
		origins.forEach((origin, index) => origin.connect(backends[index].url));
		const responses = await Promise.all(origins.map((origin) => exchange(origin.url, 'request')));

		assert.deepEqual(
			responses.map((buffer) => buffer.toString()),
			['first', 'second']
		);
	} finally {
		await Promise.all(origins.map((origin) => origin.close()));
		await Promise.all(backends.map((backend) => backend.close()));
	}
});

test(
	'unready or lost backend closes clients; teardown closes active sockets and the listener',
	{ timeout: 10_000 },
	async () => {
		const origin = await openOrigin();

		let accepted;

		const ready = new Promise((resolve) => {
			accepted = resolve;
		});

		const backend = await listen((socket) => socket.once('data', accepted));

		try {
			assert.equal((await exchange(origin.url, 'before readiness')).length, 0);
			origin.connect(backend.url);
			const pending = exchange(origin.url, 'held request');
			await ready;
			await origin.close();

			await pending.catch((error) => {
				assert.match(error.code, /ECONNREFUSED|ECONNRESET/);
			});

			await assert.rejects(exchange(origin.url, 'after teardown'), { code: 'ECONNREFUSED' });
		} finally {
			await origin.close();
			await backend.close();
		}

		const second = await openOrigin();
		const lost = await listen((socket) => socket.end());
		second.connect(lost.url);
		await lost.close();

		try {
			assert.equal((await exchange(second.url, 'backend unavailable')).length, 0);
		} finally {
			await second.close();
		}
	}
);
