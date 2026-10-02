import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { controlCheckout, startControl, assertReleased } from './control-process.mjs';

for (const [ci, vendors, expected] of [
	[false, 'postgres', 0],
	[true, 'postgres', 1],
	[true, 'sqlite3', 0],
	[true, 'sqlite3,postgres', 1],
])
	test(`${ci ? 'CI' : 'local'} execution accounts for ${vendors}`, { timeout: 60000 }, async () => {
		const checkout = await controlCheckout(['harness/controls/ci-execution.case.ts']);

		const run = startControl(['run.mjs', '--vendor', vendors], {
			cwd: checkout.root,
			env: { CI: ci ? 'true' : 'false' },
		});

		try {
			assert.equal(await run.done, expected, run.output());
			const directory = run.output().match(/^Integration results: (.+)$/m)?.[1];
			const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
			assert.equal(summary.exitCode, expected);
			if (ci && vendors.includes('postgres')) assert.match(run.output(), /CI requires a nonzero runnable selection/);
			if (!ci) assert.match(run.output(), /NOT APPLICABLE/);
			if (vendors.includes('sqlite3')) assert.equal(summary.results[0].passed, 1);

			for (const vendor of vendors.split(',')) {
				await assert.rejects(access(join(directory, vendor, 'container.json')), { code: 'ENOENT' });
				await assertReleased(join(directory, vendor));
			}
		} finally {
			await run.stop();
			await checkout.remove();
		}
	});
