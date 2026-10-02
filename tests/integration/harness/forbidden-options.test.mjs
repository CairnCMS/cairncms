import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const mode of ['only', 'retry', 'repeats', 'fails', 'concurrent']) {
	test(`native ${mode} is rejected before provisioning or executing a body`, { timeout: 30_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-option-'));

		const child = spawn(process.execPath, ['harness/vendor.mjs'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				CONTROL_OPTION: mode,
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'postgres',
					directory,
					filters: ['forbidden-options.case.ts'],
					collectAll: true,
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

			assert.equal(code, 1, output);

			assert.match(
				output,
				/Cases must run serially once, without retries or inverted failures|Unexpected declared only|Unexpected \.only modifier|only.*not.*allowed|only.*not permitted/i
			);

			assert.doesNotMatch(output, /FORBIDDEN_OPTION_BODY_EXECUTED|Starting owned|database starting/);

			assert(
				!(await readdir(join(directory, 'postgres'))).some(
					(name) => name.endsWith('.owner.json') || name === 'container.json'
				)
			);
		} finally {
			child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});
}
