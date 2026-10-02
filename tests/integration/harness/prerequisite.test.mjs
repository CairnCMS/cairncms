import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const phase of ['api', 'identities', 'schema']) {
	test(
		`failed ${phase} prerequisite is owned once, blocks dependents and preserves independent work`,
		{ timeout: 30_000 },
		async () => {
			const directory = await mkdtemp(join(tmpdir(), 'cairn-prerequisite-'));

			const child = spawn(process.execPath, ['harness/vendor.mjs'], {
				cwd: root,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					CONTROL_PREREQUISITE: phase,
					INTEGRATION_OPTIONS: JSON.stringify({
						vendor: 'sqlite3',
						directory,
						filters: ['prerequisite.case.ts'],
						collectAll: true,
						services: false,
						configFile: join(root, 'harness/controls.config.ts'),
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
					child.once('error', reject);
					child.once('exit', resolve);
				});

				assert.equal(code, 1, output);
				assert.doesNotMatch(output, /^DEPENDENT_BODY|^INDEPENDENT_DEPENDENT_BODY/m);
				assert.match(output, /^INDEPENDENT_BODY$/m);
				assert.equal(output.match(new RegExp(`^ATTEMPT_${phase.toUpperCase()}$`, 'gm'))?.length, 1, output);
				const execution = JSON.parse(await readFile(join(directory, 'sqlite3/execution.json'), 'utf8'));
				assert.equal(execution.filter((t) => t.result.state === 'failed').length, 2, output);
				assert.equal(execution.filter((t) => t.result.state === 'passed').length, 1, output);
				assert.equal(execution.filter((t) => t.result.state === 'skipped').length, 2, output);
				assert.equal(execution.filter((t) => t.meta.integrationSetupFailure).length, 2, output);

				assert.equal(
					execution.filter((t) => t.meta.integrationBlockedBy && !t.meta.integrationSetupFailure).length,
					2,
					output
				);
			} finally {
				child.kill('SIGKILL');
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
}
