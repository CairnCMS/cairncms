import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const mode of ['missing', 'late', 'lazy', 'auto', 'hook']) {
	test(`fixture registration and deadline: ${mode}`, { timeout: 30000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-registration-'));

		const child = spawn(process.execPath, ['harness/vendor.mjs'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				CONTROL_REGISTRATION: mode,
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: ['fixture-registration.case.ts'],
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

			assert.equal(code, ['auto', 'hook'].includes(mode) ? 0 : 1, output);
			if (mode === 'missing') assert.match(output, /Missing initializeFixtures/);
			if (mode === 'late') assert.match(output, /Hook timeout changed after initializeFixtures/);
			if (mode === 'lazy') assert.match(output, /Test timed out in 100ms/);
			assert.doesNotMatch(output, /database starting|Starting owned/);

			assert(
				!(await readdir(join(directory, 'sqlite3'))).some(
					(name) => name.endsWith('.owner.json') || name === 'container.json'
				)
			);
		} finally {
			child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});
}
