process.once('disconnect', () => process.exit(1));
process.argv = [process.execPath, 'cairncms', 'bootstrap'];
await import('../../../api/dist/cli/run.js');
