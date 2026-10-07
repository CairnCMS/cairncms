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

const requestRecord = '{"req":{"url":"/graphql/system"},"msg":"request completed"}\n';
const errorRecord = '{"err":{"message":"Variable got invalid value --redact--"}}\n';
const completeWhen = (logs) => logs.includes('"err":{"message":"Variable got invalid value');

for (const order of ['request-first', 'error-first']) {
	for (const delivery of ['one chunk', 'separate chunks']) {
		test(`log capture waits for both records: ${order}, ${delivery}`, async () => {
			const server = child();
			const capture = new TestLogger(server, '/graphql/system', undefined, { completeWhen });
			const pending = capture.getLogs();
			const records = order === 'request-first' ? [requestRecord, errorRecord] : [errorRecord, requestRecord];

			if (delivery === 'one chunk') server.stdout.write(records.join(''));
			else {
				server.stdout.write(records[0]);
				assert.equal(server.stdout.listenerCount('data'), 1, 'Capture ended after only one record');
				server.stdout.write(records[1]);
			}

			assert.equal(await pending, records.join(''));
			assert.equal(server.stdout.listenerCount('data'), 0);
			assert.equal(server.listenerCount('exit'), 0);
			assert.equal(server.listenerCount('error'), 0);
		});
	}

	test(`an unredacted error remains visible: ${order}`, async () => {
		const server = child();
		const capture = new TestLogger(server, '/graphql/system', undefined, { completeWhen });
		const unredacted = errorRecord.replace('--redact--', 'secret-value');
		const records = order === 'request-first' ? [requestRecord, unredacted] : [unredacted, requestRecord];
		server.stdout.write(records.join(''));
		const logs = await capture.getLogs();
		assert.equal(logs, records.join(''));
		assert.match(logs, /secret-value/);
	});
}

for (const [missing, records] of [
	['error', requestRecord],
	['request', errorRecord],
	['matching error', requestRecord + '{"err":{"message":"An unrelated error"}}\n'],
]) {
	test(`incomplete capture rejects when the ${missing} record is missing`, async () => {
		const server = child();
		const capture = new TestLogger(server, '/graphql/system', undefined, { completeWhen, timeoutMs: 10 });
		server.stdout.write(records);
		await assert.rejects(capture.getLogs(), /deadline/);
		assert.equal(server.stdout.listenerCount('data'), 0);
		assert.equal(server.listenerCount('exit'), 0);
		assert.equal(server.listenerCount('error'), 0);
	});
}

test('API exit after request completion still rejects an incomplete capture', async () => {
	const server = child();
	const capture = new TestLogger(server, '/graphql/system', undefined, { completeWhen });
	server.stdout.write(requestRecord);
	server.emit('exit', 1);
	await assert.rejects(capture.getLogs(), /API exited/);
	assert.equal(server.stdout.listenerCount('data'), 0);
	assert.equal(server.listenerCount('error'), 0);
});

test('a failing completion condition rejects capture and releases listeners', async () => {
	const server = child();
	const failure = new Error('Unable to inspect log records');

	const capture = new TestLogger(server, '/graphql/system', undefined, {
		completeWhen: () => {
			throw failure;
		},
	});

	server.stdout.write(requestRecord);
	await assert.rejects(capture.getLogs(), (error) => error === failure);
	assert.equal(server.stdout.listenerCount('data'), 0);
	assert.equal(server.listenerCount('exit'), 0);
	assert.equal(server.listenerCount('error'), 0);
});
