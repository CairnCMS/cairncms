import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const extended of [false, true]) {
	test(`fixture setup respects the file hook deadline; extended=${extended}`, { timeout: 30_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-fixture-deadline-'));

		const child = spawn(process.execPath, ['harness/vendor.mjs'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				CONTROL_LONG_FIXTURE: String(extended),
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: ['fixture-timeout.case.ts'],
					collectAll: true,
					services: false,
					configFile: join(root, 'harness/fixture-timeout.config.ts'),
				}),
			},
		});

		let output = '';
		for (const stream of [child.stdout, child.stderr])
			stream.on('data', (data) => {
				output += data;
			});

		try {
			const code = await new Promise((resolve, reject) => {
				child.once('exit', resolve);
				child.once('error', reject);
			});

			const report = JSON.parse(await readFile(join(directory, 'sqlite3/results.json'), 'utf8'));
			assert.equal(code, extended ? 0 : 1, output);
			assert.equal(report.numTotalTests, 1, output);
			assert.equal(report.numPassedTests, extended ? 1 : 0, output);
			assert.equal(report.numFailedTests, extended ? 0 : 1, output);
			if (!extended) assert.match(output, /Hook timed out in 300ms/);
		} finally {
			child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});
}
