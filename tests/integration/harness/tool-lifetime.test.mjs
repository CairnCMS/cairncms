import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const lifetime = fileURLToPath(new URL('./tool-lifetime.mjs', import.meta.url));

test('tool owner IPC does not prevent natural successful exit', { timeout: 5_000 }, async () => {
	const child = spawn(process.execPath, ['--import', lifetime, '-e', 'process.stdout.write("finished")'], {
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});

	let output = '';

	child.stdout.on('data', (chunk) => {
		output += chunk;
	});

	try {
		const [status, signal] = await once(child, 'close');
		assert.equal(status, 0);
		assert.equal(output, 'finished');
		assert.equal(signal, null);
	} finally {
		child.kill('SIGKILL');
	}
});

test('loss of the owner terminates a live tool process', { timeout: 5_000 }, async () => {
	const child = spawn(
		process.execPath,
		['--import', lifetime, '-e', 'setInterval(()=>{},1000);process.send("ready")'],
		{
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		}
	);

	try {
		await once(child, 'message');
		const ended = once(child, 'exit');
		child.disconnect();
		const [status, signal] = await ended;
		assert.equal(status, null);
		assert.equal(signal, 'SIGTERM');
		assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
	} finally {
		child.kill('SIGKILL');
	}
});
