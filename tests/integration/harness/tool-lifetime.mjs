// Run the tool's actual entry point; retain its require.main and argv semantics.
// Disconnect is a last-resort owner-loss path in addition to normal fixture teardown.
process.once('disconnect', () => {
	process.kill(process.pid, 'SIGTERM');
	setTimeout(() => process.exit(1), 5_000).unref();
});

process.channel?.unref();
