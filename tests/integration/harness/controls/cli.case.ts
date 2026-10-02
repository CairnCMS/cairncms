import { expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('compiled CLI snapshots the owned database and preserves stdout/stderr and status', async ({ api }) => {
	const path = join(api.directory, 'snapshot');
	const snapshot = await api.cli(['config', 'snapshot', path, '--yes'], { env: { LOG_STYLE: 'raw' } });
	expect(snapshot.status).toBe(0);
	expect(snapshot.signal).toBeNull();
	expect(snapshot.stdout).toContain('Snapshot:');
	expect(await readFile(join(path, 'cairncms-config.yaml'), 'utf8')).toContain('version:');

	// Exceeds the pipe buffer: the child rejects the command without consuming it.
	const rejected = await api.cli(['not-a-command'], { stdin: 'unused input\n'.repeat(1_000_000) });
	expect(rejected.status).toBe(1);
	expect(rejected.stderr).toMatch(/unknown command/);
	await request(api.url).get('/server/ping').expect(200);
});

test('CLI deadline stops and waits for the owned process', async ({ api }) => {
	await expect(api.cli(['config', 'snapshot', join(api.directory, 'timed-out')], { timeoutMs: 1 })).rejects.toThrow(
		/CLI exceeded 1ms/
	);

	expect(api.available()).toBe(true);
});

test('owned Node tool preserves entry arguments, nonzero status, output and deadline cleanup', async ({ api }) => {
	const entry = join(api.directory, 'owned-tool.mjs');

	await writeFile(
		entry,
		"process.stdout.write(process.argv[1] + ':' + process.argv[2]); process.stderr.write('tool failure'); process.exit(7)"
	);

	const tool = api.startNode(entry, ['argument']);
	tool.child.stdin!.end();
	const result = await tool.result;
	expect(result.status).toBe(7);
	expect(result.signal).toBeNull();
	expect(result.stdout).toBe(entry + ':argument');
	expect(result.stderr).toBe('tool failure');
	await writeFile(entry, 'setInterval(()=>{},1000)');
	const hung = api.startNode(entry, [], { timeoutMs: 100 });
	await expect(hung.result).rejects.toThrow(/CLI exceeded 100ms/);
	expect(() => process.kill(hung.child.pid!, 0)).toThrow(/ESRCH/);
	expect(api.available()).toBe(true);
});
