import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendorResult } from './results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [vendor, mode, expectedPassed, expectedExcluded, expectedCode] of [
	['sqlite3', '', 1, 2, 0],
	['postgres', '', 3, 0, 0],
	['sqlite3', 'all-excluded', 0, 2, 0],
	['postgres', 'unapproved', 0, 0, 1],
])
	test(`native applicability ${vendor}/${mode || 'mixed'}`, { timeout: 30_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-applicability-'));

		const child = spawn(process.execPath, ['harness/vendor.mjs'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				CONTROL_APPLICABILITY: mode,
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor,
					directory,
					filters: ['applicability.case.ts'],
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
				child.once('exit', resolve);
				child.once('error', reject);
			});

			const result = await readVendorResult(join(directory, vendor), code);
			assert.equal(code, expectedCode, output);
			assert.equal(result.exitCode, expectedCode, JSON.stringify(result));
			assert.equal(result.passed, expectedPassed);
			assert.equal(result.excluded.length, expectedExcluded);
			if (expectedCode === 0) assert.deepEqual(result.evidenceErrors, []);
			else assert.match(output, /Unexpected declared skip/);
			assert(!output.includes('Starting owned'));
		} finally {
			child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});
