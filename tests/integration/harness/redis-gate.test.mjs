import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { openRedisGate } from './redis-gate.mjs';

function connect(url) {
	const target = new URL(url);
	return net.connect({ host: target.hostname, port: Number(target.port) });
}

test('Redis gate forwards no startup bytes, recovers, destroys established sessions, and reuses its owned port', async () => {
	const upstreamSockets = new Set();
	let bytes = 0;

	const upstream = net.createServer((socket) => {
		upstreamSockets.add(socket);

		socket.on('data', (data) => {
			bytes += data.length;
			socket.write(data);
		});

		socket.on('error', () => {});
		socket.once('close', () => upstreamSockets.delete(socket));
	});

	upstream.listen(0, '127.0.0.1');
	await once(upstream, 'listening');
	const gate = await openRedisGate(`redis://127.0.0.1:${upstream.address().port}/5`);

	try {
		const blocked = connect(gate.url);
		blocked.on('error', () => {});
		blocked.on('connect', () => blocked.write('must not reach Redis'));
		await once(blocked, 'close');
		assert.equal(bytes, 0);
		gate.enable();
		const first = connect(gate.url);
		first.on('error', () => {});
		await once(first, 'connect');
		const echoed = once(first, 'data');
		first.write('live');
		assert.equal(String((await echoed)[0]), 'live');
		const disconnected = once(first, 'close');
		gate.disable();
		await disconnected;
		assert.equal(bytes, 4);
		gate.enable();
		const second = connect(gate.url);
		second.on('error', () => {});
		await once(second, 'connect');
		const recovered = once(second, 'data');
		second.write('recovered');
		assert.equal(String((await recovered)[0]), 'recovered');
		const stopped = once(second, 'close');
		await gate.close();
		await stopped;
		assert.throws(() => gate.enable(), /closed/);
		const gone = connect(gate.url);
		assert.equal((await once(gone, 'error'))[0].code, 'ECONNREFUSED');
	} finally {
		await gate.close();
		for (const socket of upstreamSockets) socket.destroy();
		await new Promise((resolve) => upstream.close(resolve));
	}
});

test('Redis gate cancellation releases the reserved listener', async () => {
	const controller = new AbortController();
	const gate = await openRedisGate('redis://127.0.0.1:1/0', controller.signal);
	controller.abort();
	await gate.close();
	const gone = connect(gate.url);
	assert.equal((await once(gone, 'error'))[0].code, 'ECONNREFUSED');
});
