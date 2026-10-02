import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { assertSuccessfulLoad } from './load-result.mjs';

const exec = promisify(execFile);
const valid = { errors: 0, timeouts: 0, non2xx: 0, '2xx': 3, requests: { total: 3, sent: 4 } };
const outcome = (report) => ({ status: 0, signal: null, stdout: JSON.stringify(report), stderr: '' });

test('successful responses permit requests still in flight at the end of a timed burst', () => {
	assert.deepEqual(assertSuccessfulLoad(outcome(valid)), valid);
});

for (const [name, report] of [
	['connection error', { ...valid, errors: 1 }],
	['timeout', { ...valid, timeouts: 1 }],
	['HTTP error with zero connection errors', { ...valid, non2xx: 1 }],
	['no completed responses', { ...valid, '2xx': 0, requests: { total: 0 } }],
	['missing counts', {}],
	['inconsistent completed count', { ...valid, requests: { total: 4 } }],
	['invalid counts', { ...valid, errors: '0' }],
])
	test(`rejects ${name}`, () => assert.throws(() => assertSuccessfulLoad(outcome(report))));

test('rejects malformed output and failed child processes', () => {
	assert.throws(() => assertSuccessfulLoad({ ...outcome(valid), stdout: '' }));
	assert.throws(() => assertSuccessfulLoad({ ...outcome(valid), status: 1 }));
	assert.throws(() => assertSuccessfulLoad({ ...outcome(valid), signal: 'SIGTERM' }));
});

for (const behavior of ['success', 'http-error', 'timeout'])
	test(`real Autocannon JSON reports ${behavior}`, { timeout: 15000 }, async () => {
		const server = createServer((_req, res) => {
			if (behavior === 'timeout') return;
			res.statusCode = behavior === 'http-error' ? 503 : 200;
			res.end('fixture');
		});

		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

		try {
			const entry = createRequire(import.meta.url).resolve('autocannon/autocannon.js');

			const { stdout, stderr } = await exec(
				process.execPath,
				[entry, '--json', '-c', '1', '-d', '2', '-t', '1', `http://127.0.0.1:${server.address().port}`],
				{ timeout: 10000 }
			);

			const result = { status: 0, signal: null, stdout, stderr };

			if (behavior === 'success') assertSuccessfulLoad(result);
			else {
				assert.throws(() => assertSuccessfulLoad(result));
				const report = JSON.parse(stdout);
				assert(report[behavior === 'http-error' ? 'non2xx' : 'timeouts'] > 0);
			}
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
