import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(directory, filters, collectAll, release) {
	const child = spawn(process.execPath, ['harness/vendor.mjs'], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			CONTROL_RELEASE: release ?? '',
			INTEGRATION_OPTIONS: JSON.stringify({
				vendor: 'sqlite3',
				directory,
				filters,
				collectAll,
				services: false,
				configFile: join(root, 'harness/controls.config.ts'),
			}),
		},
	});

	let output = '';
	let failureObserved;
	const listeners = [];
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (data) => {
			output += data.toString();
			if (output.includes('[sqlite3] FAILURE') && failureObserved === undefined) failureObserved = Date.now();
			for (const listener of listeners) listener();
		});

	const done = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', resolve);
	});

	return {
		child,
		done,
		output: () => output,
		failureLatency: () => failureObserved - Number(output.match(/^ASSERTION_AT (\d+)$/m)?.[1]),
		async until(predicate) {
			if (predicate(output)) return;

			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Output condition timed out:\n${output}`)), 20_000);

				listeners.push(() => {
					if (predicate(output)) {
						clearTimeout(timer);
						resolve();
					}
				});
			});
		},
	};
}

for (const collectAll of [false, true])
	test(`piped failure is immediate; collectAll=${collectAll}`, { timeout: 30_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-reporting-'));
		const release = join(directory, 'release');
		const runCase = run(directory, ['assertion.case.ts'], collectAll, release);

		try {
			if (collectAll) {
				await runCase.until((output) => /^LATER_STARTED$/m.test(output) && output.includes('EARLY_FAILURE_DETAIL'));
				assert(!/^LATER_FINISHED$/m.test(runCase.output()));
				await writeFile(release, 'release');
			}

			assert.equal(await runCase.done, 1);
			assert.match(runCase.output(), /EARLY_FAILURE_DETAIL/);
			process.stdout.write(`Failure visibility collectAll=${collectAll}: ${runCase.failureLatency()}ms\n`);
			assert.equal(/^LATER_STARTED$/m.test(runCase.output()), collectAll);
			assert.equal(/^LATER_FINISHED$/m.test(runCase.output()), collectAll);
		} finally {
			runCase.child.kill('SIGKILL');
			await rm(directory, { recursive: true, force: true });
		}
	});

test('collect-all retains import and setup failures while running independent tests', { timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-reporting-'));
	const runCase = run(directory, ['import.case.ts', 'setup.case.ts', 'assertion.case.ts'], true);

	try {
		assert.equal(await runCase.done, 1);
		assert.match(runCase.output(), /CONTROL_IMPORT_FAILURE/);
		assert.match(runCase.output(), /CONTROL_SETUP_FAILURE/);
		assert.match(runCase.output(), /LATER_FINISHED/);
	} finally {
		runCase.child.kill('SIGKILL');
		await rm(directory, { recursive: true, force: true });
	}
});
