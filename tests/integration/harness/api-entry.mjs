// Register owner-disconnect handling before importing the application: startup can fail too.
const stop = () => {
	process.kill(process.pid, 'SIGTERM');
	setTimeout(() => process.exit(1), 5_000).unref();
};

process.once('disconnect', stop);
const { default: env } = await import('../../../api/dist/env.js');
const { resolveChild } = await import('../../../api/dist/extensions/confined/supervisor.js');
const confinedChild = resolveChild();
if (!confinedChild.isBundled || confinedChild.execArgv.length)
	throw new Error('Integration requires the production confined bundle; development child resolution is forbidden');
const { default: emitter } = await import('../../../api/dist/emitter.js');
const { startServer } = await import('../../../api/dist/server.js');

emitter.onAction('server.start', ({ server }) => {
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
	process.send?.({ type: 'ready', url: `http://127.0.0.1:${address.port}`, publicUrl: env.PUBLIC_URL, confinedChild });
});

await startServer();
