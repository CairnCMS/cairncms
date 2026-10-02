import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlCheckout, startControl } from './control-process.mjs';
import { readVendorResult } from './results.mjs';

for (const workers of ['0', '5', '-1', '1.5', '2x', 'Infinity']) {
	test(`rejects invalid worker count ${workers} before provisioning`, () => {
		const result = spawnSync(process.execPath, ['run.mjs', `--workers=${workers}`], {
			cwd: fileURLToPath(new URL('../', import.meta.url)),
			encoding: 'utf8',
			env: { ...process.env, CI: 'false' },
		});

		assert.equal(result.status, 2);
		assert.match(result.stderr, /--workers must be an integer from 1 to 4/);
		assert.doesNotMatch(result.stdout, /Integration results:|Starting owned/);
	});
}

test(
	'keeps configured workers available while an isolated file waits for queued work',
	{ timeout: 30000 },
	async () => {
		const files = ['a', 'b', 'c'].map((name) => `harness/controls/worker-queue-${name}.case.ts`);
		const checkout = await controlCheckout(files);
		const directory = await mkdtemp(join(tmpdir(), 'cairn-worker-queue-'));
		let run;

		try {
			for (const file of files)
				await writeFile(
					join(checkout.root, file),
					`import { test, expect } from 'vitest';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeFixtures } from '../fixture-setup.mjs';
initializeFixtures();
const directory = process.env.CONTROL_WORKER_DIRECTORY;
async function claim(name) {
  try { await mkdir(join(directory, name)); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}
test('queued work releases the waiting file', async () => {
  if (await claim('waiting')) {
    await expect.poll(() => access(join(directory, 'released')).then(() => true, () => false), {
      timeout: 3000, message: 'Queued file did not run while another file was active'
    }).toBe(true);
  } else if (!(await claim('finished'))) {
    await writeFile(join(directory, 'released'), 'complete');
  }
});
`
				);

			run = startControl(['harness/vendor.mjs'], {
				cwd: checkout.root,
				env: {
					CONTROL_WORKER_DIRECTORY: directory,
					INTEGRATION_OPTIONS: JSON.stringify({
						vendor: 'sqlite3',
						workers: 2,
						directory,
						filters: [],
						collectAll: true,
						services: false,
					}),
				},
			});

			const code = await run.done;
			assert.equal(code, 0, run.output());
			const report = await readVendorResult(join(directory, 'sqlite3'), code);
			assert.equal(report.exitCode, 0, JSON.stringify(report));
			assert.equal(report.passed, 3);
		} finally {
			await run?.stop();
			await checkout.remove();
			await rm(directory, { recursive: true, force: true });
		}
	}
);
