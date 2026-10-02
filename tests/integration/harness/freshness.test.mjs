import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { verifyPreparation } from './freshness.mjs';
import { seedBuildWorkspace, recordBuildWorkspace } from './freshness-workspace.mjs';

for (const file of [
	'api/src/server.js',
	'api/src/new-file.ts',
	'api/src/templates/README.md',
	'packages/example/src/index.ts',
	'sdk/src/index.ts',
	'api/package.json',
	'tsconfig.json',
	'pnpm-lock.yaml',
	'api/dist/server.js',
	'packages/example/dist/index.js',
	'sdk/dist/index.js',
])
	test(`freshness rejects changed build input or output: ${file}`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'cairn-freshness-'));

		try {
			await seedBuildWorkspace(root);
			await recordBuildWorkspace(root);
			await verifyPreparation(root);
			const previous = await readFile(join(root, file), 'utf8').catch(() => '');
			await mkdir(join(root, file, '..'), { recursive: true });
			await writeFile(join(root, file), previous + '\n');
			await assert.rejects(verifyPreparation(root), /Stale compiled build.*pnpm test:integration:prepare/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

test('test and documentation edits leave build freshness valid', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cairn-freshness-'));

	try {
		await seedBuildWorkspace(root);
		await recordBuildWorkspace(root);
		for (const file of [
			'api/src/server.test.ts',
			'packages/example/src/index.test.ts',
			'api/README.md',
			'README.md',
			'tests/integration/new.test.ts',
		])
			await writeFile(join(root, file), 'edited');
		await verifyPreparation(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const damage of [
	'missing record',
	'invalid record',
	'old record',
	'deleted source',
	'deleted artifact',
	'deleted workspace output',
])
	test(`freshness rejects ${damage}`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'cairn-freshness-'));

		try {
			await seedBuildWorkspace(root);
			await recordBuildWorkspace(root);
			const record = join(root, 'tests/integration/.artifacts/prepared.json');
			if (damage === 'missing record') await rm(record);
			if (damage === 'invalid record') await writeFile(record, '{');
			if (damage === 'old record') await writeFile(record, '{}');
			if (damage === 'deleted source') await rm(join(root, 'api/src/server.js'));
			if (damage === 'deleted artifact') await rm(join(root, 'api/dist/server.js'));
			if (damage === 'deleted workspace output') await rm(join(root, 'packages/example/dist'), { recursive: true });
			await assert.rejects(verifyPreparation(root), /pnpm test:integration:prepare/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

for (const mode of ['failed build', 'inputs changed during build'])
	test(`preparation cannot certify ${mode}`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'cairn-freshness-'));

		try {
			await seedBuildWorkspace(root);

			await writeFile(
				join(root, 'api/build.mjs'),
				mode === 'failed build'
					? 'process.exit(7);'
					: "import { appendFileSync } from 'node:fs'; appendFileSync('src/server.js', '\\n// changed during build');"
			);

			await recordBuildWorkspace(root);
			await cp(new URL('../prepare.mjs', import.meta.url), join(root, 'tests/integration/prepare.mjs'));
			await mkdir(join(root, 'tests/integration/harness'));
			for (const name of ['artifacts.mjs', 'freshness.mjs'])
				await cp(new URL(name, import.meta.url), join(root, 'tests/integration/harness', name));

			const child = spawn(process.execPath, ['tests/integration/prepare.mjs'], {
				cwd: root,
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let output = '';
			for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += chunk));

			const code = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', resolve);
			});

			assert.notEqual(code, 0, output);
			assert.match(output, mode === 'failed build' ? /Preparation failed/ : /inputs changed during preparation/);
			await assert.rejects(readFile(join(root, 'tests/integration/.artifacts/prepared.json')), { code: 'ENOENT' });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
