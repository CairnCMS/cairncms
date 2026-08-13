import net from 'node:net';

const listenPort = Number(process.argv[2]);
const upstreamPort = Number(process.argv[3]);
const upstreamHost = process.argv[4] ?? '127.0.0.1';

const sockets = [];

function track(socket) {
	sockets.push(socket);

	socket.on('close', () => {
		const index = sockets.indexOf(socket);
		if (index !== -1) sockets.splice(index, 1);
	});

	socket.on('error', () => socket.destroy());
}

const server = net.createServer((client) => {
	const upstream = net.connect(upstreamPort, upstreamHost);
	track(client);
	track(upstream);
	client.pipe(upstream);
	upstream.pipe(client);
	client.on('close', () => upstream.destroy());
	upstream.on('close', () => client.destroy());
});

server.on('error', (error) => {
	process.stderr.write(`REDIS_PROXY_ERROR ${error.message}\n`);
	process.exit(1);
});

server.listen(listenPort, '127.0.0.1', () => {
	process.stdout.write('REDIS_PROXY_READY\n');
});

function shutdown() {
	for (const socket of sockets.slice()) socket.destroy();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
