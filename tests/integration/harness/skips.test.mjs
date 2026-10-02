import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendorResult } from './results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const mode of ['declared', 'dynamic']) {
	test(`native ${mode} skip has explicit accounting`, { timeout: 30_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-skips-'));

		const child = spawn(process.execPath, ['harness/vendor.mjs'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				CONTROL_SKIP: mode,
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: ['skips.case.ts'],
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

			const result = await readVendorResult(join(directory, 'sqlite3'), code);
			assert.equal(code, 1, output);
			assert.equal(result.exitCode, code, JSON.stringify(result));
			if (mode === 'declared') assert.match(output, /Unexpected declared skip/);
			if (mode === 'dynamic') assert.equal(result.unexpectedSkips.length, 1);
		} finally {
			child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});
}
