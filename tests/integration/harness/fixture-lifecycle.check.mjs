import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { assertReleased, controlCheckout, integrationRoot, startControl } from './control-process.mjs';
import { readVendorResult } from './results.mjs';
import { buildArtifacts } from './freshness.mjs';

for (const mode of ['identity', 'setup', 'body'])
	test(`real fixture ${mode} failure retains its causes and releases resources`, { timeout: 120000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-fixture-failure-'));

		const run = startControl(['harness/vendor.mjs'], {
			env: {
				CONTROL_FIXTURE_FAILURE: mode,
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: ['fixture-failures.case.ts'],
					collectAll: true,
					configFile: join(integrationRoot, 'harness/controls.config.ts'),
				}),
			},
		});

		try {
			assert.equal(await run.done, 1, run.output());
			const result = await readVendorResult(join(directory, 'sqlite3'), 1);

			if (mode === 'body') {
				assert.equal(result.failures.length, 2);
				assert.match(run.output(), /CONTROL_PRIMARY_BODY/);
			} else {
				assert.equal(result.failures.length, 1);
				assert.equal(result.blocked.length, 1);
				assert.doesNotMatch(run.output(), /^CONTROL_DEPENDENT_BODY$/m);
			}

			if (mode === 'identity') {
				assert.match(run.output(), /expected 200.*got 400/);
				assert.equal(result.fileErrors.length, 0);
			} else {
				assert.match(run.output(), /CONTROL_CLEANUP_FAILURE/);
				assert(result.fileErrors.length > 0);
			}

			if (mode === 'setup') assert.match(run.output(), /CONTROL_PRIMARY_SETUP/);
			await assertReleased(join(directory, 'sqlite3'));
		} finally {
			await run.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});

for (const [name, vendor, count] of [
	['cli', 'sqlite3', 3],
	['origin', 'sqlite3', 2],
	['multiple-api', 'sqlite3', 1],
	['destructive', 'postgres', 1],
	['timezone', 'mysql', 1],
])
	test(`owned ${name} fixture (${vendor})`, { timeout: 180000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-owned-fixture-'));

		const run = startControl(['harness/vendor.mjs'], {
			env: {
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor,
					directory,
					filters: [name + '.case.ts'],
					collectAll: true,
					configFile: join(integrationRoot, 'harness/controls.config.ts'),
				}),
			},
		});

		try {
			assert.equal(await run.done, 0, run.output());
			const result = await readVendorResult(join(directory, vendor), 0);
			assert.equal(result.exitCode, 0, JSON.stringify(result));
			assert.equal(result.passed, count);
			await assertReleased(join(directory, vendor));

			if (name === 'origin') {
				const urls = JSON.parse(await readFile(join(directory, vendor, 'companion-origins.json'), 'utf8'));
				assert.equal(new Set(urls).size, 3);
				for (const url of urls)
					await assert.rejects(
						new Promise((resolve, reject) => {
							const address = new URL(url),
								socket = net.connect({ host: address.hostname, port: Number(address.port) });

							socket.setTimeout(2000, () => socket.destroy(new Error('Listener teardown probe timed out')));

							socket.once('connect', () => {
								socket.destroy();
								resolve();
							});

							socket.once('error', reject);
						}),
						{ code: 'ECONNREFUSED' }
					);
			}
		} finally {
			await run.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});

test('real entrypoint rejects a development confined child', { timeout: 120000 }, async () => {
	const checkout = await controlCheckout(['harness/controls/cancel.case.ts'], { copyApi: true });
	const { writeFile } = await import('node:fs/promises');
	const resolver = join(checkout.directory, 'api/dist/extensions/confined/supervisor.js');
	const original = await readFile(resolver, 'utf8');
	assert.equal(original.split('if (existsSync(bundledPath))').length, 2);
	await writeFile(resolver, original.replace('if (existsSync(bundledPath))', 'if (false && existsSync(bundledPath))'));
	// This control supplies a deliberately faulty build to exercise the independent
	// runtime-resolution check, after the artifact-integrity check has passed.
	const recordPath = join(checkout.root, '.artifacts/prepared.json');
	const prepared = JSON.parse(await readFile(recordPath, 'utf8'));
	prepared.artifacts = await buildArtifacts(checkout.directory, prepared.buildInputs.packages);
	await writeFile(recordPath, JSON.stringify(prepared));
	const run = startControl(['run.mjs', '--vendor', 'sqlite3'], { cwd: checkout.root });

	try {
		assert.equal(await run.done, 1, run.output());
		assert.match(run.output(), /development child resolution is forbidden/);
		assert.doesNotMatch(run.output(), /EXECUTION_READY/);
		const directory = run.output().match(/^Integration results: (.+)$/m)[1];
		await assertReleased(join(directory, 'sqlite3'));
	} finally {
		await run.stop();
		await checkout.remove();
	}
});
