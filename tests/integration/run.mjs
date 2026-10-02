/* eslint-disable no-console */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { readVendorResult } from './harness/results.mjs';
import { cleanupAfterExit } from './harness/exit-cleanup.mjs';
import { vendors as supportedVendors } from './harness/database-vendors.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
let args;

try {
	args = parseArgs({
		options: {
			vendor: { type: 'string' },
			workers: { type: 'string' },
			'collect-all': { type: 'boolean' },
			testNamePattern: { type: 'string', short: 't' },
			list: { type: 'boolean' },
			verbose: { type: 'boolean' },
			output: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
} catch (error) {
	console.error(error.message);
	process.exit(2);
}

if (args.values.help) {
	console.log(
		`pnpm test:integration [file filters] [-t REGEX] [--vendor ${supportedVendors.join(
			'|'
		)}|all] [--collect-all] [--workers 1|2|3|4] [--list] [--verbose] [--output DIR]`
	);

	process.exit(0);
}

if (args.values.workers !== undefined && !/^[1-4]$/.test(args.values.workers)) {
	console.error('--workers must be an integer from 1 to 4.');
	process.exit(2);
}

const workers = Number(args.values.workers ?? 1);

const ci = !!process.env.CI && process.env.CI !== 'false';

if (ci && !args.values.vendor && !process.env.TEST_DB) {
	console.error('CI requires an explicit TEST_DB or --vendor; use the full vendor matrix or all.');
	process.exit(2);
}

const vendor = args.values.vendor ?? process.env.TEST_DB ?? 'postgres';
const vendors = vendor === 'all' ? supportedVendors : vendor.split(',');

if (!vendors.length || vendors.some((v) => !supportedVendors.includes(v)) || new Set(vendors).size !== vendors.length) {
	console.error(`Choose --vendor ${supportedVendors.join(', ')}, or all.`);
	process.exit(2);
}

if (ci && (args.positionals.length || args.values.testNamePattern)) {
	console.error('CI must run every integration suite: file and test-name filters are local-only.');
	process.exit(2);
}

if (ci && args.values.list) {
	console.error('CI requires test execution; --list is local-only.');
	process.exit(2);
}

try {
	if (args.values.testNamePattern) new RegExp(args.values.testNamePattern);
} catch (error) {
	console.error(`Invalid test-name pattern: ${error.message}`);
	process.exit(2);
}

const collectAll = ci || !!args.values['collect-all'];
const artifactRoot = resolve(args.values.output ?? join(root, '.artifacts'));
await mkdir(artifactRoot, { recursive: true });
const directory = await mkdtemp(join(artifactRoot, 'run-'));
console.log(`Integration results: ${directory}`);
let current;
let cancelled = false;
let exitCode = 0;
const summary = [];
for (const signal of ['SIGINT', 'SIGTERM'])
	process.once(signal, () => {
		cancelled = true;
		exitCode = signal === 'SIGINT' ? 130 : 143;
		if (current?.connected) current.send({ type: 'cancel', signal }, () => {});
		// Worker finally blocks get a grace period. IPC disconnect stops orphan API/bootstrap children.
		setTimeout(() => current?.kill('SIGKILL'), 20_000).unref();
	});

for (const selected of vendors) {
	if (cancelled) break;
	console.log(`\n[${selected}] ${collectAll ? 'collect-all' : 'fail-fast'}; retries disabled`);
	const started = performance.now();

	current = spawn(process.execPath, [fileURLToPath(new URL('harness/vendor.mjs', import.meta.url))], {
		cwd: root,
		stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
		detached: true,
		env: {
			...process.env,
			INTEGRATION_OPTIONS: JSON.stringify({
				ci,
				vendor: selected,
				workers,
				collectAll,
				filters: args.positionals,
				pattern: args.values.testNamePattern,
				list: args.values.list,
				verbose: args.values.verbose,
				directory,
			}),
		},
	});

	const child = current;

	const code = await new Promise((resolve) => {
		child.once('error', (error) => {
			console.error(error);
			resolve(1);
		});

		child.once('exit', (code) => resolve(code ?? 1));
	});

	current = undefined;

	const result = await readVendorResult(join(directory, selected), code, args.values.list, ci);

	if (result.exitCode !== 0) {
		try {
			result.exitCleanup = await cleanupAfterExit(join(directory, selected), child.pid);
			result.evidenceErrors.push(...result.exitCleanup.errors);

			await writeFile(
				join(directory, selected, 'exit-cleanup.json'),
				JSON.stringify(result.exitCleanup, null, 2) + '\n'
			);
		} catch (error) {
			result.evidenceErrors.push(`Exit cleanup failed: ${error}`);
		}
	}

	summary.push({
		...result,
		vendor: selected,
		workers,
		durationMs: performance.now() - started,
	});

	if (result.exitCode !== 0) {
		exitCode ||= 1;
		if (!collectAll) break;
	}
}

await writeFile(
	`${directory}/summary.json`,
	JSON.stringify({ vendors, cancelled, exitCode, results: summary }, null, 2) + '\n'
);

const onlyExcluded =
	summary.length > 0 && summary.every((result) => result.selected === 0 && result.excluded.length > 0);

let status = 'PASSED';
if (onlyExcluded) status = 'NOT APPLICABLE';
if (args.values.list) status = 'LISTED';
if (exitCode) status = 'FAILED';
console.log(`\n${status}: ${summary.map((r) => `${r.vendor}=${r.exitCode}`).join(', ')}; results ${directory}`);

for (const result of summary) {
	for (const failure of result.fileErrors ?? [])
		console.error(
			`[${result.vendor}] FILE FAILURE ${failure.file}: ${failure.errors.map((error) => error.message).join('; ')}`
		);
	if (result.infrastructureError) console.error(`[${result.vendor}] ${result.infrastructureError}`);
	for (const error of result.evidenceErrors) console.error(`[${result.vendor}] INCOMPLETE/FAILED: ${error}`);
	for (const failure of result.failures)
		console.error(`[${result.vendor}] ${failure.file} > ${failure.name}: ${failure.result.errors?.[0]?.message}`);
	if (!args.values.list && result.selected === 0 && result.excluded.length > 0)
		console.log(
			`[${result.vendor}] NOT APPLICABLE: zero runnable cases; ${result.excluded.length} declared vendor exclusions`
		);
	if (!args.values.list)
		console.log(
			`[${result.vendor}] ${result.passed} passed; ${result.failures.length} failed; ${result.blocked.length} blocked; ${result.unexpectedSkips.length} unexpected skips; ${result.notRun.length} selected but not run; ${result.excluded.length} excluded with reasons`
		);
}

if (args.values.list && exitCode === 0) await rm(directory, { recursive: true, force: true });
process.exitCode = exitCode;
