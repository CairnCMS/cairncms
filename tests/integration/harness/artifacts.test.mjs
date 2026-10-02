import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compiledArtifacts } from './artifacts.mjs';

for (const missing of ['child-host.mjs', 'emscripten-module.wasm', 'sdk/dist/index.js']) {
	test(`missing compiled ${missing} fails with an actionable preparation error`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'cairn-artifacts-'));

		try {
			for (const file of [
				'api/dist/server.js',
				'api/dist/cli/run.js',
				'api/dist/extensions/confined/child-host.ts',
				'api/dist/extensions/confined/runtime/child-host.mjs',
				'api/dist/extensions/confined/runtime/emscripten-module.wasm',
				'sdk/dist/index.js',
			]) {
				await mkdir(dirname(join(root, file)), { recursive: true });
				if (!file.endsWith(missing)) await writeFile(join(root, file), 'fixture artifact');
			}

			await assert.rejects(
				compiledArtifacts(root),
				(error) => error.message.includes(missing) && error.message.includes('pnpm test:integration:prepare')
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
