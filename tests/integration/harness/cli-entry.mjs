process.once('disconnect', () => process.exit(1));
process.argv = [process.execPath, 'cairncms', ...process.argv.slice(2)];
await import('../../../api/dist/cli/run.js');
