import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const [pattern, count] of [
	['nested group first$', 1],
	['^literal > group nested group first$', 1],
	['literal > group', 2],
	['^outside$', 1],
]) {
	test(`native name filter agrees between collection and execution: ${pattern}`, { timeout: 30_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-name-pattern-'));

		const child = spawn(process.execPath, ['harness/vendor.mjs'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: ['name-pattern.case.ts'],
					pattern,
					collectAll: true,
					services: false,
					configFile: join(root, 'harness/controls.config.ts'),
				}),
			},
		});

		let output = '';
		for (const stream of [child.stdout, child.stderr])
			stream.on('data', (chunk) => {
				output += chunk;
			});

		try {
			const code = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', resolve);
			});

			assert.equal(code, 0, output);
			const selection = JSON.parse(await readFile(join(directory, 'sqlite3/selection.json'), 'utf8'));
			const execution = JSON.parse(await readFile(join(directory, 'sqlite3/execution.json'), 'utf8'));
			assert.equal(selection.length, count);
			assert.equal(execution.filter((t) => t.result.state === 'passed').length, count);
			assert.equal(execution.filter((t) => t.result.state === 'failed').length, 0);
		} finally {
			child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});
}
