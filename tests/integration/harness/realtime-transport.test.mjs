import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrationRoot, startControl } from './control-process.mjs';

test('GraphQL transport preserves subscription outcomes and connection failures', { timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-realtime-transport-'));

	const control = startControl(['harness/vendor.mjs'], {
		env: {
			INTEGRATION_OPTIONS: JSON.stringify({
				vendor: 'sqlite3',
				directory,
				filters: ['realtime-transport.case.ts'],
				collectAll: true,
				services: false,
				configFile: join(integrationRoot, 'harness/controls.config.ts'),
			}),
		},
	});

	try {
		assert.equal(await control.done, 0, control.output());
		const execution = JSON.parse(await readFile(join(directory, 'sqlite3/execution.json'), 'utf8'));
		assert.equal(execution.length, 7);

		assert(
			execution.every((entry) => entry.result.state === 'passed'),
			control.output()
		);
	} finally {
		await control.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
