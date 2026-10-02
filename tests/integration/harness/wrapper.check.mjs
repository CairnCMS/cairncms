import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertReleased, controlCheckout, owners, startControl, docker } from './control-process.mjs';

for (const phase of ['data', 'empty'])
	test(
		`public command finishes directory cleanup after a worker dies during ${phase} removal`,
		{ timeout: 120000 },
		async () => {
			const checkout = await controlCheckout(['harness/controls/wrapper.case.ts']);
			let run;

			try {
				await writeFile(
					join(checkout.root, 'harness/controls/wrapper.case.ts'),
					`import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';
initializeFixtures();
test('cleanup crash control', async ({ api }) => {
  await fetch(api.url + '/server/ping');
  process.env.CONTROL_CLEANUP_WORKER = String(process.pid);
});`
				);

				const path = join(checkout.root, 'harness/owned-directory.mjs');
				const source = await readFile(path, 'utf8');

				const point =
					phase === 'data'
						? "if (entry !== '.integration-owner.json') await rm(join(directory, entry), { recursive: true, force: true });"
						: "await rm(join(directory, '.integration-owner.json'), { force: true });";

				assert.equal(source.split(point).length, 2);

				const crash = `if (${
					phase === 'data' ? "entry !== '.integration-owner.json' && " : ''
				}process.env.CONTROL_CLEANUP_WORKER === String(process.pid)) {
const message = 'CLEANUP_CRASH ' + JSON.stringify(await readdir(directory)) + '\\n';
await new Promise((resolve) => process.stdout.write(message, resolve));
process.kill(process.pid, 'SIGKILL');
}`;

				await writeFile(path, source.replace(point, point + '\n' + crash));
				run = startControl(['run.mjs', '--vendor', 'sqlite3'], { cwd: checkout.root });
				assert.equal(await run.done, 1, run.output());
				const entries = JSON.parse(run.output().match(/CLEANUP_CRASH (\[.*\])/)[1]);
				if (phase === 'data') {
					assert(entries.includes('.integration-owner.json'));
					assert(entries.length > 1);
				} else assert.deepEqual(entries, []);

				const directory = run.output().match(/^Integration results: (.+)$/m)[1];
				const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
				assert.equal(summary.exitCode, 1);
				assert.deepEqual(summary.results[0].exitCleanup.errors, []);
				await assertReleased(join(directory, 'sqlite3'));
			} finally {
				await run?.stop();
				await checkout.remove();
			}
		}
	);

for (const collectAll of [false, true])
	test(`public command ${collectAll ? 'continues' : 'stops'} after a failed vendor`, { timeout: 120000 }, async () => {
		const checkout = await controlCheckout(['harness/controls/wrapper.case.ts']);

		const run = startControl(['run.mjs', '--vendor', 'sqlite3,postgres', ...(collectAll ? ['--collect-all'] : [])], {
			cwd: checkout.root,
		});

		try {
			assert.equal(await run.done, 1, run.output());
			const directory = run.output().match(/^Integration results: (.+)$/m)?.[1];
			const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));

			assert.deepEqual(
				summary.results.map((result) => result.vendor),
				collectAll ? ['sqlite3', 'postgres'] : ['sqlite3']
			);

			assert.equal(summary.exitCode, 1);
			assert.match(run.output(), /WRAPPER_BODY_sqlite3/);
			if (collectAll) {
				assert.match(run.output(), /WRAPPER_BODY_postgres/);
				assert.equal(summary.results[1].passed, 1);
			} else assert.doesNotMatch(run.output(), /WRAPPER_BODY_postgres|Starting owned/);
			for (const result of summary.results) await assertReleased(join(directory, result.vendor));
		} finally {
			await run.stop();
			await checkout.remove();
		}
	});

test('public command distinguishes declared non-applicability from passed cases', { timeout: 30000 }, async () => {
	const checkout = await controlCheckout(['harness/controls/applicability.case.ts']);

	const run = startControl(['run.mjs', '--vendor', 'sqlite3'], {
		cwd: checkout.root,
		env: { CONTROL_APPLICABILITY: 'all-excluded' },
	});

	try {
		assert.equal(await run.done, 0, run.output());
		assert.match(run.output(), /NOT APPLICABLE:.*sqlite3=0/);
		assert.match(run.output(), /zero runnable cases; 2 declared vendor exclusions/);
		assert.doesNotMatch(run.output(), /^PASSED:|database starting|Starting owned/m);
	} finally {
		await run.stop();
		await checkout.remove();
	}
});

for (const signal of ['SIGINT', 'SIGTERM'])
	test(`public command handles OS ${signal} and releases its children`, { timeout: 120000 }, async () => {
		const checkout = await controlCheckout(['harness/controls/cancel.case.ts']);
		const run = startControl(['run.mjs', '--vendor', 'sqlite3'], { cwd: checkout.root });

		try {
			await run.poll(() => run.output().includes('EXECUTION_READY'));
			run.child.kill(signal);
			assert.equal(await run.done, signal === 'SIGINT' ? 130 : 143, run.output());
			const directory = run.output().match(/^Integration results: (.+)$/m)?.[1];
			const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
			assert.equal(summary.cancelled, true);
			await assertReleased(join(directory, 'sqlite3'));
		} finally {
			await run.stop();
			await checkout.remove();
		}
	});

test('public command propagates API teardown errors', { timeout: 120000 }, async () => {
	const checkout = await controlCheckout(['harness/controls/late-exit.case.ts']);
	const run = startControl(['run.mjs', '--vendor', 'sqlite3'], { cwd: checkout.root });

	try {
		assert.equal(await run.done, 1, run.output());
		assert.match(run.output(), /api-entry.mjs exited SIGKILL/);
		const directory = run.output().match(/^Integration results: (.+)$/m)?.[1];
		const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
		assert(summary.results[0].fileErrors.length > 0, JSON.stringify(summary));
		await assertReleased(join(directory, 'sqlite3'));
	} finally {
		await run.stop();
		await checkout.remove();
	}
});

test('concurrent PostgreSQL commands own independent containers and resources', { timeout: 180000 }, async () => {
	const checkout = await controlCheckout(['harness/controls/cancel.case.ts']);
	const runs = [0, 1].map(() => startControl(['run.mjs', '--vendor', 'postgres'], { cwd: checkout.root }));

	try {
		await Promise.all(runs.map((run) => run.poll(() => run.output().includes('EXECUTION_READY'))));
		const directories = runs.map((run) => join(run.output().match(/^Integration results: (.+)$/m)[1], 'postgres'));

		const records = await Promise.all(
			directories.map((directory) => readFile(join(directory, 'container.json'), 'utf8').then(JSON.parse))
		);

		assert.equal(new Set(records.map((record) => record.id)).size, 2);
		const resources = (await Promise.all(directories.map((directory) => owners(directory)))).flat();
		assert.equal(resources.length, 2);
		assert.equal(new Set(resources.map((owner) => owner.directory)).size, 2);
		runs[0].child.kill('SIGINT');
		assert.equal(await runs[0].done, 130, runs[0].output());
		await assertReleased(directories[0]);
		assert.equal(runs[1].child.exitCode, null);
		const surviving = await docker('docker', ['inspect', '--format', '{{.State.Running}}', records[1].id]);
		assert.equal(surviving.stdout.trim(), 'true');
		const survivingUrl = runs[1].output().match(/EXECUTION_READY (http:\/\/[^\s]+)/)[1];
		const response = await fetch(survivingUrl + '/server/ping', { signal: AbortSignal.timeout(10000) });
		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'pong');
		runs[1].child.kill('SIGTERM');
		assert.equal(await runs[1].done, 143, runs[1].output());
		await assertReleased(directories[1]);
	} finally {
		await Promise.all(runs.map((run) => run.stop()));
		await checkout.remove();
	}
});
