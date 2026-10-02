import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlCheckout, startControl } from './control-process.mjs';
import { readVendorResult } from './results.mjs';

const files = ['a.load.test.ts', 'b.load.test.ts', 'c.test.ts', 'd.test.ts'];

for (const [scenario, filters, selected, passed, exitCode] of [
	['all', [], 4, 4, 0],
	['shuffle', [], 4, 4, 0],
	['load selection', ['a.load.test.ts'], 1, 1, 0],
	['ordinary selection', ['controls/c.test.ts', 'controls/d.test.ts'], 2, 2, 0],
	['bail', [], 4, 0, 1],
	['collect all', [], 4, 2, 1],
	['cancel', [], 4, 1, 143],
])
	test(`native load scheduling: ${scenario}`, { timeout: 30000 }, async () => {
		const checkout = await controlCheckout(files.map((file) => `harness/controls/${file}`));
		const directory = await mkdtemp(join(tmpdir(), 'cairn-scheduling-'));
		let run;

		try {
			for (const file of files)
				await writeFile(
					join(checkout.root, 'harness/controls', file),
					`import { beforeAll, afterAll, test, expect, inject } from 'vitest';
import { mkdir, readdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeFixtures } from '../fixture-setup.mjs';
initializeFixtures();
const directory = process.env.CONTROL_SCHEDULING_DIRECTORY;
const scenario = process.env.CONTROL_SCHEDULING_SCENARIO;
const file = ${JSON.stringify(file)};
const load = file.includes('.load.');
let locked = false;
beforeAll(async () => {
  expect(inject('integration').vendor).toBe('sqlite3');
  if (load) {
    await mkdir(join(directory, 'load-lock'));
    locked = true;
    expect((await readdir(directory)).filter(name => name.endsWith('.ordinary'))).toHaveLength(0);
  } else {
    if (scenario !== 'ordinary selection')
      expect((await readdir(directory)).filter(name => name.endsWith('.done'))).toHaveLength(2);
    await writeFile(join(directory, file + '.ordinary'), 'started');
  }
});
afterAll(async () => {
  if (locked) {
    await rm(join(directory, 'load-lock'), { recursive: true });
    await writeFile(join(directory, file + '.done'), 'released');
  }
});
test('executes ' + file, async () => {
  if (load && scenario === 'cancel') {
    await writeFile(join(directory, 'entered'), 'running');
    await expect.poll(() => access(join(directory, 'release')).then(() => true, () => false), { timeout: 10000 }).toBe(true);
  }
  if (load && ['bail', 'collect all'].includes(scenario)) throw new Error('CONTROL_LOAD_FAILURE');
  if (!load) await expect.poll(async () =>
    (await readdir(directory)).filter(name => name.endsWith('.ordinary')).length, { timeout: 5000 }).toBe(2);
});
`
				);

			run = startControl(['harness/vendor.mjs'], {
				cwd: checkout.root,
				env: {
					CONTROL_SCHEDULING_DIRECTORY: directory,
					CONTROL_SCHEDULING_SCENARIO: scenario,
					INTEGRATION_OPTIONS: JSON.stringify({
						vendor: 'sqlite3',
						workers: 2,
						sequence: scenario === 'shuffle' ? { shuffle: true, seed: 17 } : undefined,
						directory,
						filters,
						pattern: scenario === 'load selection' ? 'executes a' : undefined,
						collectAll: scenario !== 'bail',
						services: false,
					}),
				},
			});

			if (scenario === 'cancel') {
				await run.poll(() => readdir(directory).then((names) => names.includes('entered')));
				run.child.send({ type: 'cancel', signal: 'SIGTERM' });
				// Let the cancellation message reach Vitest before releasing the active body.
				await new Promise((resolve) => setTimeout(resolve, 250));
				await writeFile(join(directory, 'release'), 'finish');
			}

			const code = await run.done;
			assert.equal(code, exitCode, run.output());
			const report = await readVendorResult(join(directory, 'sqlite3'), code);
			const names = await readdir(directory);
			assert(!names.includes('load-lock'), run.output());
			assert.equal(report.selected, selected);
			assert.equal(report.passed, passed, run.output());

			if (!exitCode) assert.equal(report.exitCode, 0, JSON.stringify(report));

			if (['bail', 'cancel'].includes(scenario)) {
				assert.equal(names.filter((name) => name.endsWith('.ordinary')).length, 0, run.output());
				assert(report.notRun.length + report.unexpectedSkips.length > 0);
			}

			if (scenario === 'collect all') assert.equal(report.failures.length, 2, run.output());
			const outcome = JSON.parse(await readFile(join(directory, 'sqlite3/outcome.json'), 'utf8'));
			assert.equal(outcome.cancelled, scenario === 'cancel');
			assert.equal(outcome.infrastructureError, undefined, run.output());
			assert.deepEqual(outcome.fileErrors, [], run.output());
		} finally {
			await run?.stop();
			await checkout.remove();
			await rm(directory, { recursive: true, force: true });
		}
	});
