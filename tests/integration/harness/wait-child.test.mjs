import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitChild } from './wait-child.mjs';

function launch(script) {
	return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}

test('rejects when the child already exited before the wait starts', async () => {
	const child = launch("process.stderr.write('boot failure marker'); process.exit(7)");
	await once(child, 'close');
	await assert.rejects(waitChild(child, { ready: true }), /exited before readiness .*code=7/);
});

test('rejects with captured output when the child exits during the wait', async () => {
	const child = launch("setTimeout(() => { process.stderr.write('late failure'); process.exit(4); }, 500)");

	await assert.rejects(waitChild(child, { ready: true }), (error) => {
		assert.match(error.message, /exited before readiness .*code=4/);
		assert.match(error.message, /late failure/);
		return true;
	});
});

test('readiness requires the ready message and removes its listeners', async () => {
	const child = launch(
		"process.send({type:'noise'});setTimeout(()=>{process.send({type:'ready',url:'http://owned'});process.disconnect()},25)"
	);

	assert.deepEqual(await waitChild(child, { ready: true }), { type: 'ready', url: 'http://owned' });
	assert.equal(child.listenerCount('message'), 0);
	assert.equal(child.stderr.listenerCount('data'), 0);
	await once(child, 'close');
});

test('zero exit completes bootstrap but fails API startup', async () => {
	await waitChild(launch('process.exit(0)'), { ready: false });
	await assert.rejects(waitChild(launch('process.exit(0)'), { ready: true }), /code=0/);
});

test('readiness timeout rejects and leaves process termination to its owner', async () => {
	const child = launch('setInterval(()=>{},1000)');

	try {
		await assert.rejects(waitChild(child, { ready: true, timeoutMs: 30 }), /exceeded 30ms/);
		assert.equal(child.listenerCount('message'), 0);
		assert.equal(child.stderr.listenerCount('data'), 0);
	} finally {
		const closed = once(child, 'close');
		child.kill();
		await closed;
	}
});

test('spawn failure is reported without waiting for the readiness deadline', async () => {
	const child = spawn('/does-not-exist-cairn-readiness', [], { stdio: 'pipe' });
	await assert.rejects(waitChild(child, { ready: true }), /ENOENT/);
});
