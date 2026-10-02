import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { controlCheckout, startControl, assertReleased } from './control-process.mjs';
import { seedBuildWorkspace, recordBuildWorkspace } from './freshness-workspace.mjs';

test(
	'public execution rejects stale inputs before services; discovery and test-only edits remain usable',
	{ timeout: 180000 },
	async () => {
		const checkout = await controlCheckout(['harness/controls/freshness.case.ts']);

		try {
			for (const path of ['api', 'sdk', 'app', 'packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
				await rm(join(checkout.directory, path));
			await seedBuildWorkspace(checkout.directory);
			await recordBuildWorkspace(checkout.directory);

			const run = async (args, code, pattern) => {
				const process = startControl(['run.mjs', ...args], { cwd: checkout.root });

				try {
					assert.equal(await process.done, code, process.output());
					if (pattern) assert.match(process.output(), pattern);
					assert.doesNotMatch(process.output(), /Starting owned/);
					const directory = process.output().match(/^Integration results: (.+)$/m)?.[1];

					if (!args.includes('--list')) {
						const vendor = args[args.indexOf('--vendor') + 1];
						await assert.rejects(access(join(directory, vendor, 'container.json')), { code: 'ENOENT' });
						await assertReleased(join(directory, vendor));
					}
				} finally {
					await process.stop();
				}
			};

			for (const file of [
				'api/src/server.js',
				'api/src/untracked.ts',
				'packages/example/src/index.ts',
				'api/package.json',
				'tsconfig.json',
				'pnpm-lock.yaml',
				'api/dist/server.js',
				'packages/example/dist/index.js',
				'tests/integration/.artifacts/prepared.json',
			]) {
				const target = join(checkout.directory, file);
				const previous = await readFile(target).catch(() => null);

				await writeFile(
					target,
					file.endsWith('prepared.json') ? '{' : Buffer.concat([previous ?? Buffer.from(''), Buffer.from('\n')])
				);

				await run(['--vendor', 'postgres'], 1, /pnpm test:integration:prepare/);
				if (previous) await writeFile(target, previous);
				else await rm(target);
			}

			await rm(join(checkout.directory, 'tests/integration/.artifacts/prepared.json'));
			await run(['--vendor', 'postgres'], 1, /Missing or invalid preparation record/);
			await run(['--vendor', 'sqlite3', '--list'], 0, /LISTED/);
			await recordBuildWorkspace(checkout.directory);
			await writeFile(join(checkout.directory, 'api/src/server.test.ts'), 'test-only edit');
			await run(['--vendor', 'sqlite3'], 0, /1 passed/);
			await writeFile(join(checkout.directory, 'api/src/server.js'), 'export const healthy = false;');
			await run(['--vendor', 'sqlite3'], 1, /Stale compiled build/);
			await writeFile(join(checkout.directory, 'api/dist/server.js'), 'export const healthy = false;');
			await recordBuildWorkspace(checkout.directory);
			await run(['--vendor', 'sqlite3'], 1, /expected false to be true/);
			for (const file of ['api/src/server.js', 'api/dist/server.js'])
				await writeFile(join(checkout.directory, file), 'export const healthy = true;');
			await recordBuildWorkspace(checkout.directory);
			await run(['--vendor', 'sqlite3'], 0, /1 passed/);
		} finally {
			await checkout.remove();
		}
	}
);
