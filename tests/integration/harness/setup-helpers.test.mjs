import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControl, integrationRoot, assertReleased } from './control-process.mjs';

test(
	'actual setup helpers reject failed and malformed responses with diagnostic context',
	{ timeout: 60000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-helper-responses-'));

		const run = startControl(['harness/vendor.mjs'], {
			env: {
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: ['setup-helpers.case.ts'],
					collectAll: true,
					services: false,
					configFile: join(integrationRoot, 'harness/controls.config.ts'),
				}),
			},
		});

		try {
			assert.equal(await run.done, 0, run.output());
			const results = JSON.parse(await readFile(join(directory, 'sqlite3/results.json'), 'utf8'));
			assert.equal(results.numPassedTests, 60);
			assert.equal(results.numFailedTests, 0);
		} finally {
			await run.stop();
			await rm(directory, { recursive: true, force: true });
		}
	}
);

test('setup error context reaches live output and reports without dependent bodies', { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-helper-report-'));

	const run = startControl(['harness/vendor.mjs'], {
		env: {
			INTEGRATION_OPTIONS: JSON.stringify({
				vendor: 'sqlite3',
				directory,
				filters: ['setup-report.case.ts'],
				collectAll: true,
				services: false,
				configFile: join(integrationRoot, 'harness/controls.config.ts'),
			}),
		},
	});

	try {
		assert.equal(await run.done, 1, run.output());
		const { readVendorResult } = await import('./results.mjs');
		const result = await readVendorResult(join(directory, 'sqlite3'), 1);
		assert.equal(result.failures.length, 1);
		assert.equal(result.blocked.length, 1);

		for (const output of [
			run.output(),
			...(await Promise.all(
				['execution', 'results', 'outcome'].map((name) => readFile(join(directory, 'sqlite3', name + '.json'), 'utf8'))
			)),
		]) {
			assert.doesNotMatch(output, /UNEXPECTED_DEPENDENT_BODY/);
		}

		for (const output of [run.output(), JSON.stringify(result.failures)]) {
			assert.match(output, /SETUP_ERROR_CONTEXT report-fixture-token-67241/);
			assert.match(output, /INVALID_PAYLOAD/);
			assert.match(output, /users/);
			assert.match(output, /400/);
		}

		await assertReleased(join(directory, 'sqlite3'));
	} finally {
		await run.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
