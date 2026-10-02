import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const mode of ['missing executable', 'failed graph command']) {
	test(`preparation invalidates old success after ${mode}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-preparation-'));
		const integration = join(directory, 'tests/integration');
		const record = join(integration, '.artifacts/prepared.json');

		try {
			await mkdir(join(integration, '.artifacts'), { recursive: true });
			await mkdir(join(integration, 'harness'));
			for (const name of ['artifacts.mjs', 'freshness.mjs'])
				await copyFile(new URL(name, import.meta.url), join(integration, 'harness', name));
			await mkdir(join(directory, 'bin'));
			await copyFile(new URL('../prepare.mjs', import.meta.url), join(integration, 'prepare.mjs'));
			await writeFile(record, JSON.stringify({ preparedAt: 'old-success' }));
			if (mode === 'failed graph command')
				await writeFile(join(directory, 'bin/pnpm'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });

			const child = spawn(process.execPath, [join(integration, 'prepare.mjs')], {
				env: { ...process.env, PATH: join(directory, 'bin') },
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let output = '';
			for (const stream of [child.stdout, child.stderr])
				stream.on('data', (chunk) => {
					output += chunk;
				});

			const code = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', resolve);
			});

			assert.equal(code, 1, output);
			assert.match(output, /Preparation failed/);
			if (mode === 'missing executable') assert.match(output, /Could not read pnpm build graph/);
			await assert.rejects(access(record));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
