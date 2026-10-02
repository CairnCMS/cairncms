/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildFilters, buildInputs, buildArtifacts, assertSameInputs, hash } from './harness/freshness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const started = Date.now();

const record = new URL('.artifacts/prepared.json', import.meta.url);
const signals = new Map();
let interrupted;

try {
	await rm(record, { force: true });
	const inputs = await buildInputs(root);

	// TypeScript emission does not remove outputs whose source files were deleted.
	for (const pkg of inputs.packages) {
		const manifest = JSON.parse(await readFile(root + pkg.path + '/package.json', 'utf8'));
		if (manifest.scripts?.build) await rm(root + pkg.path + '/dist', { recursive: true, force: true });
	}

	const child = spawn('pnpm', ['--recursive', ...buildFilters, '--workspace-concurrency=1', 'run', 'build'], {
		cwd: root,
		stdio: 'inherit',
	});

	for (const signal of ['SIGINT', 'SIGTERM']) {
		const handler = () => {
			interrupted = signal;
			child.kill(signal);
		};

		signals.set(signal, handler);
		process.once(signal, handler);
	}

	const code = await new Promise((resolve, reject) => {
		child.once('error', (error) => reject(new Error(`Could not start pnpm: ${error.message}`)));
		child.once('exit', resolve);
	});

	if (code !== 0 || interrupted) {
		console.error(
			`Preparation failed (${interrupted ?? code ?? 'child terminated'}); no successful build record was written.`
		);

		process.exitCode = { SIGINT: 130, SIGTERM: 143 }[interrupted] ?? (code || 1);
	} else {
		assertSameInputs(inputs, await buildInputs(root));
		const artifacts = await buildArtifacts(root, inputs.packages);
		assertSameInputs(inputs, await buildInputs(root));
		await mkdir(new URL('.artifacts/', import.meta.url), { recursive: true });

		await writeFile(
			record,
			JSON.stringify(
				{
					format: 1,
					buildInputs: inputs,
					revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
					trackedDiffSha256: hash(
						execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
					),
					lockfileSha256: hash(await readFile(root + 'pnpm-lock.yaml')),
					node: process.version,
					artifacts,
					preparedAt: new Date().toISOString(),
					durationMs: Date.now() - started,
				},
				null,
				2
			) + '\n'
		);
	}
} catch (error) {
	console.error(`Preparation failed: ${error.message}`);
	process.exitCode = 1;
} finally {
	for (const [signal, handler] of signals) process.off(signal, handler);
}
