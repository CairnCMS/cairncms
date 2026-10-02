import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ownCli } from './owned-cli.mjs';

async function stop(child) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const closed = once(child, 'close');
	child.kill('SIGKILL');
	await closed;
}

function launch(script, options = {}) {
	return ownCli(spawn(process.execPath, ['-e', script], { stdio: 'pipe' }), { stop, ...options });
}

test('interactive CLI keeps stdin open through a prompt and captures final output', async () => {
	const cli = launch(
		`process.stdout.write('continue?'); process.stdin.once('data', data => { process.stdout.write(data); process.stderr.write('done'); process.stdin.destroy(); });`
	);

	try {
		await once(cli.child.stdout, 'data');
		assert.equal(cli.output(), 'continue?');
		assert.equal(cli.child.exitCode, null);
		cli.child.stdin.end('yes\n');
		assert.deepEqual(await cli.result, { status: 0, signal: null, stdout: 'continue?yes\n', stderr: 'done' });
	} finally {
		await stop(cli.child);
	}
});

test('CLI timeout kills and waits for a hung interactive child', async () => {
	const cli = launch('setInterval(() => {}, 1000)', { timeoutMs: 20 });
	await assert.rejects(cli.result, /CLI exceeded 20ms/);
	assert.throws(() => process.kill(cli.child.pid, 0), /ESRCH/);
	assert.equal(cli.child.stdout.listenerCount('data'), 0);
});

test('caller cancellation settles the CLI and preserves its termination signal', async () => {
	const cli = launch('setInterval(() => {}, 1000)');
	await stop(cli.child);
	assert.equal((await cli.result).signal, 'SIGKILL');
});

test('early command rejection preserves stderr and status despite a large stdin pipe', async () => {
	const cli = launch(`process.stderr.write('unknown command'); process.exit(2)`);
	cli.child.stdin.end('unused input\n'.repeat(1_000_000));
	assert.deepEqual(await cli.result, { status: 2, signal: null, stdout: '', stderr: 'unknown command' });
});

test('CLI capture preserves a UTF-8 character split across output writes', async () => {
	const cli = launch(
		`const b=Buffer.from('secrét');process.stdout.write(b.subarray(0,5));setTimeout(()=>process.stdout.write(b.subarray(5)),20)`
	);

	assert.equal((await cli.result).stdout, 'secrét');
});

test('spawn failure remains observable after a caller was waiting for a prompt', async () => {
	const cli = ownCli(spawn('/does-not-exist-cairn-cli-control', [], { stdio: 'pipe' }), { stop });
	await delay(20);
	await assert.rejects(cli.result, /ENOENT/);
});
