import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertReleased, integrationRoot, startControl } from './control-process.mjs';
import { readVendorResult } from './results.mjs';

for (const [service, count] of [
	['redis6', 1],
	['redis7', 1],
	['redis60', 1],
	['saml', 4],
	['storage', 2],
]) {
	test(`owned ${service} connects to its real API and removes its resources`, { timeout: 120000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-service-fixture-'));

		const run = startControl(['harness/vendor.mjs'], {
			env: {
				INTEGRATION_OPTIONS: JSON.stringify({
					vendor: 'sqlite3',
					directory,
					filters: [service + '.case.ts'],
					collectAll: true,
					configFile: join(integrationRoot, 'harness/controls.config.ts'),
				}),
			},
		});

		try {
			assert.equal(await run.done, 0, run.output());
			const result = await readVendorResult(join(directory, 'sqlite3'), 0);
			assert.equal(result.exitCode, 0, JSON.stringify(result));
			assert.equal(result.passed, count);
			await assertReleased(join(directory, 'sqlite3'));
		} finally {
			await run.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
