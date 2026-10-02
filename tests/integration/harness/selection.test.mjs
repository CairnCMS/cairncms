import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

async function run(args, ci = '') {
	const child = spawn(process.execPath, ['run.mjs', ...args], {
		cwd: root,
		env: { ...process.env, CI: ci, TEST_DB: 'sqlite3' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (data) => {
			output += data;
		});

	const code = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', resolve);
	});

	const directory = output.match(/^Integration results: (.+)$/m)?.[1];
	if (directory) await rm(directory, { recursive: true, force: true });
	return { code, output };
}

for (const [args, diagnostic] of [
	[['--vendor', 'unknown'], /Choose --vendor/],
	[['routes/missing.test.ts'], /No test file matches/],
	[['routes/auth/login.test.ts', 'routes/missing.test.ts'], /No test file matches/],
	[['routes/auth/login.test.ts', '-t', 'NO_SUCH_CASE'], /no runnable tests/],
	[['-t', '['], /Invalid test-name pattern/],
])
	test(`invalid selection fails without provisioning: ${args.join(' ')}`, async () => {
		const result = await run(args);
		assert.notEqual(result.code, 0, result.output);
		assert.match(result.output, diagnostic);
		assert.doesNotMatch(result.output, /database starting|Starting owned/);
	});

test('CI rejects local file filters', async () => {
	const result = await run(['routes/auth/login.test.ts'], 'true');
	assert.equal(result.code, 2);
	assert.match(result.output, /CI must run every integration suite/);
});

test('CI rejects listing without provisioning', async () => {
	const result = await run(['--list'], 'true');
	assert.equal(result.code, 2);
	assert.match(result.output, /CI requires test execution/);
	assert.doesNotMatch(result.output, /Integration results:|Starting owned/);
});

test('named discovery returns exactly one independently runnable case', async () => {
	const result = await run(['routes/auth/login.test.ts', '-t', 'when correct credentials.*Admin User', '--list']);
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /Selected 1 tests in 1 files/);
	assert.doesNotMatch(result.output, /database starting|Starting owned/);
});
