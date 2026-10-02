import net from 'node:net';

// Reserve the public origin before application initialization. The backend keeps
// production startServer() semantics and reports its separate ephemeral listener.
export async function openOrigin() {
	let backend;
	let closed = false;
	const sockets = new Set();

	const server = net.createServer((incoming) => {
		if (!backend || closed) {
			incoming.destroy();
			return;
		}

		const outgoing = net.connect(backend);

		for (const socket of [incoming, outgoing]) {
			socket.setNoDelay(true);
			sockets.add(socket);

			socket.once('close', () => {
				sockets.delete(socket);
			});

			socket.once('error', () => {
				incoming.destroy();
				outgoing.destroy();
			});
		}

		incoming.once('close', () => outgoing.destroy());

		outgoing.once('close', () => {
			// Let a normal EOF flush buffered response bytes through pipe().
			if (!outgoing.readableEnded) incoming.destroy();
		});

		// Raw byte forwarding preserves Host, cookies, redirects, bodies and upgrades.
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
	return {
		url: `http://127.0.0.1:${address.port}`,
		connect(url) {
			if (closed) throw new Error('Origin is closed');
			if (backend) throw new Error('Origin already has a backend');
			const target = new URL(url);
			if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port)
				throw new Error('Expected an owned loopback HTTP backend');
			backend = { host: target.hostname, port: Number(target.port) };
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
