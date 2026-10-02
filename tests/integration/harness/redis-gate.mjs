import net from 'node:net';

// Own one stable ephemeral endpoint across real Redis outages and recoveries.
// Disabled connections are reset before any bytes can reach Redis. This retains
// the never-connected Redis state without a close-and-rebind port reservation race.
export async function openRedisGate(url, signal) {
	signal?.throwIfAborted();
	const target = new URL(url);
	if (target.protocol !== 'redis:') throw new Error('Expected a Redis fixture URL');
	let enabled = false;
	let closed = false;
	let closePromise;
	const sockets = new Set();

	const server = net.createServer((incoming) => {
		if (!enabled || closed) {
			incoming.destroy();
			return;
		}

		const outgoing = net.connect({ host: target.hostname, port: Number(target.port) });

		for (const socket of [incoming, outgoing]) {
			socket.setNoDelay(true);
			sockets.add(socket);

			socket.once('close', () => {
				sockets.delete(socket);
				incoming.destroy();
				outgoing.destroy();
			});

			socket.once('error', () => {
				incoming.destroy();
				outgoing.destroy();
			});
		}

		incoming.pipe(outgoing).pipe(incoming);
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);

		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address();

	const disable = () => {
		enabled = false;
		for (const socket of sockets) socket.destroy();
	};

	const close = () => {
		if (closePromise) return closePromise;
		closed = true;
		disable();
		signal?.removeEventListener('abort', abort);
		closePromise = new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		return closePromise;
	};

	const abort = () => {
		void close().catch(() => {});
	};

	signal?.addEventListener('abort', abort, { once: true });

	if (signal?.aborted) {
		await close();
		signal.throwIfAborted();
	}

	return {
		url: `redis://127.0.0.1:${address.port}${target.pathname}`,
		enable() {
			if (closed) throw new Error('Redis gate is closed');
			enabled = true;
		},
		disable,
		close,
	};
}
