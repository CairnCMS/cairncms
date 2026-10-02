import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TestLogger } from '../fixtures/test-logger.mjs';

function child() {
	const server = new EventEmitter();
	server.stdout = new PassThrough();
	return server;
}

test('log capture matches a whole request line across arbitrary chunks', async () => {
	const server = child();
	const capture = new TestLogger(server, '/auth/refresh', true);
	const logs = capture.getLogs();
	server.stdout.write('unrelated\n{"path":"/auth/ref');
	server.stdout.write('resh","cookie":"--redact--"}\nother\n');
	assert.equal(await logs, '{"path":"/auth/refresh","cookie":"--redact--"}\n');
	assert.equal(server.stdout.listenerCount('data'), 0);
});

test('unfiltered capture retains every preceding error line without masking data', async () => {
	const server = child();
	const capture = new TestLogger(server, '/graphql/system');
	server.stdout.write('{"err":{"message":"secret-value"}}\n{"path":"/graphql/system"}\n');
	assert.equal(await capture.getLogs(), '{"err":{"message":"secret-value"}}\n{"path":"/graphql/system"}\n');
});

test('log capture preserves a secret containing a UTF-8 character split across chunks', async () => {
	const server = child();
	const capture = new TestLogger(server, '/request');
	const bytes = Buffer.from('secrét\n/request\n');
	server.stdout.write(bytes.subarray(0, 5));
	server.stdout.write(bytes.subarray(5));
	assert.equal(await capture.getLogs(), 'secrét\n/request\n');
});

test('API exit cannot turn incomplete log capture into a pass', async () => {
	const server = child();
	const capture = new TestLogger(server, 'missing');
	server.emit('exit', 1);
	await assert.rejects(capture.getLogs(), /API exited/);
	assert.equal(server.stdout.listenerCount('data'), 0);
	assert.equal(server.listenerCount('error'), 0);
});

test('missing log marker fails within a bounded deadline and releases listeners', async () => {
	const server = child();
	const capture = new TestLogger(server, 'missing', undefined, { timeoutMs: 10 });
	await assert.rejects(capture.getLogs(), /deadline/);
	assert.equal(server.stdout.listenerCount('data'), 0);
	assert.equal(server.listenerCount('exit'), 0);
});
