import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { vendors } from './database-vendors.mjs';

const workflow = yaml.load(
	await readFile(new URL('../../../.github/workflows/ci-tests-api.yml', import.meta.url), 'utf8')
);

const shell = (script, options = {}) =>
	spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
		encoding: 'utf8',
		timeout: 10000,
		...options,
	});

test('API workflow filters documentation pushes and runs complete independent vendors', () => {
	assert.deepEqual(workflow.on, {
		push: { branches: ['develop'], 'paths-ignore': ['docs/**', 'CHANGELOG.md', 'README.md'] },
		workflow_dispatch: null,
	});

	assert.equal(workflow.env.CI, 'true');
	assert.equal(workflow.defaults.run.shell, 'bash');
	assert.deepEqual(workflow.permissions, { contents: 'read' });
	assert.deepEqual(workflow.jobs.test.strategy.matrix.include.map((entry) => entry.vendor).sort(), [...vendors].sort());
	assert.equal(workflow.jobs.test.strategy['fail-fast'], false);
	assert.equal(workflow.jobs.restoration.strategy['fail-fast'], false);

	assert.deepEqual(workflow.jobs.restoration.strategy.matrix.include.map((entry) => entry.vendor).sort(), [
		'mysql',
		'postgres',
		'sqlite3',
	]);

	for (const id of ['validation', 'restoration', 'test']) {
		const job = workflow.jobs[id];
		assert.equal(job.needs, undefined, 'Validation must not serialize vendor startup');
		assert.equal(job.if, undefined, 'Required work must not be conditionally skipped');
		assert.equal(job['continue-on-error'], undefined);
		assert.equal(job.steps.find((step) => step.uses === 'actions/checkout@v4').with.ref, '${{ github.sha }}');
		assert(job.steps.some((step) => step.run?.startsWith('pnpm test:integration:prepare ')));
		assert(job.steps.every((step) => !step['continue-on-error']));
		const upload = job.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
		assert.equal(upload.if, 'always()');
		assert.equal(upload.with['include-hidden-files'], true);
		assert.equal(upload.with['if-no-files-found'], 'error');
		assert(upload.with.name.includes('${{ github.run_attempt }}'));
	}

	const execution = workflow.jobs.test.steps.find((step) => step.name === 'Run every integration suite');
	assert.equal(execution.env.TEST_DB, '${{ matrix.vendor }}');

	assert.equal(
		execution.run,
		'pnpm test:integration --vendor "$TEST_DB" --workers 2 2>&1 | tee tests/integration/.artifacts/integration.log'
	);

	for (const command of ['typecheck', 'test:harness', 'test:lifecycle', 'test:services'])
		assert(workflow.jobs.validation.steps.some((step) => step.run?.includes(`tests-integration ${command} `)));
	assert(workflow.jobs.restoration.steps.some((step) => step.run?.includes('tests-integration test:restoration ')));
});

test('Results rejects every failed, cancelled, skipped or missing dependency combination', () => {
	const job = workflow.jobs.results;
	assert.deepEqual(job.needs, ['validation', 'restoration', 'test']);
	assert.equal(job.if, 'always()');
	assert.equal(job.name, 'Results');
	assert.equal(job.steps.length, 1);
	const step = job.steps[0];

	assert.deepEqual(step.env, {
		VALIDATION_RESULT: '${{ needs.validation.result }}',
		RESTORATION_RESULT: '${{ needs.restoration.result }}',
		TEST_RESULT: '${{ needs.test.result }}',
	});

	const states = ['success', 'failure', 'cancelled', 'skipped', ''];

	for (const validation of states)
		for (const restoration of states)
			for (const tests of states) {
				const result = shell(step.run, {
					env: {
						...process.env,
						VALIDATION_RESULT: validation,
						RESTORATION_RESULT: restoration,
						TEST_RESULT: tests,
						GITHUB_STEP_SUMMARY: '/dev/null',
					},
				});

				const succeeds = [validation, restoration, tests].every((state) => state === 'success');
				assert.equal(result.status, succeeds ? 0 : 1, `${validation}/${restoration}/${tests}: ${result.stderr}`);
			}
});

test('workflow pipelines preserve failing command status and revision checks reject different commits', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-workflow-'));

	try {
		await mkdir(join(directory, 'bin'));
		await mkdir(join(directory, 'tests/integration/.artifacts'), { recursive: true });
		await writeFile(join(directory, 'bin/pnpm'), '#!/bin/sh\necho CONTROL_COMMAND_FAILURE\nexit 7\n', { mode: 0o755 });
		await writeFile(join(directory, 'bin/git'), '#!/bin/sh\necho "$CONTROL_CHECKOUT_SHA"\n', { mode: 0o755 });

		const env = {
			...process.env,
			PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
			TEST_DB: 'postgres',
			GITHUB_SHA: 'a'.repeat(40),
			GITHUB_REF: 'refs/heads/develop',
			GITHUB_REPOSITORY: 'CairnCMS/cairncms',
			GITHUB_RUN_ID: '1',
			GITHUB_RUN_ATTEMPT: '1',
		};

		for (const id of ['validation', 'restoration', 'test']) {
			for (const step of workflow.jobs[id].steps.filter((step) => step.run?.includes('pnpm '))) {
				const result = shell(step.run, { cwd: directory, env });
				assert.equal(result.status, 7, `${id}: ${step.name}: ${result.stderr}`);
				assert.match(result.stdout, /CONTROL_COMMAND_FAILURE/);
			}

			const record = workflow.jobs[id].steps.find((step) => step.name === 'Record tested revision');

			for (const matching of [false, true]) {
				const result = shell(record.run, {
					cwd: directory,
					env: { ...env, CONTROL_CHECKOUT_SHA: matching ? env.GITHUB_SHA : 'b'.repeat(40) },
				});

				assert.equal(result.status, matching ? 0 : 1, result.stderr);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('control runs keep child reports out of job summaries while vendors publish their results', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-workflow-summary-'));
	const root = fileURLToPath(new URL('../', import.meta.url));
	const summary = join(directory, 'summary.md');
	const existing = 'Parent summary\n';

	try {
		await mkdir(join(directory, 'bin'));
		await mkdir(join(directory, 'tests/integration/.artifacts'), { recursive: true });

		await writeFile(
			join(directory, 'bin/pnpm'),
			'#!/bin/sh\nexec env -u NODE_TEST_CONTEXT "$CONTROL_NODE" --test --test-name-pattern="piped failure is immediate; collectAll=false" "$CONTROL_ROOT/harness/reporting.test.mjs"\n',
			{ mode: 0o755 }
		);

		const env = {
			...process.env,
			PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
			CONTROL_NODE: process.execPath,
			CONTROL_ROOT: root,
			GITHUB_ACTIONS: 'true',
			GITHUB_STEP_SUMMARY: summary,
			TEST_DB: 'sqlite3',
		};

		for (const [job, command] of [
			['validation', 'test:harness'],
			['validation', 'test:lifecycle'],
			['validation', 'test:services'],
			['restoration', 'test:restoration'],
		]) {
			const step = workflow.jobs[job].steps.find((step) => step.run?.includes(`tests-integration ${command} `));
			await writeFile(summary, existing);
			const result = shell(step.run, { cwd: directory, env, timeout: 30000 });
			assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /# pass 1\b/);
			assert.match(result.stdout, /# fail 0\b/);
			assert.equal(await readFile(summary, 'utf8'), existing, `${command} published a child report`);
		}

		await writeFile(
			join(directory, 'bin/pnpm'),
			'#!/bin/sh\ncd "$CONTROL_ROOT"\nexec "$CONTROL_NODE" harness/vendor.mjs\n',
			{ mode: 0o755 }
		);

		const vendor = workflow.jobs.test.steps.find((step) => step.name === 'Run every integration suite');

		for (const [filter, code, label] of [
			['name-pattern.case.ts', 0, '✅'],
			['assertion.case.ts', 1, '❌'],
		]) {
			await writeFile(summary, existing);

			const result = shell(vendor.run, {
				cwd: directory,
				timeout: 30000,
				env: {
					...env,
					CONTROL_RELEASE: '',
					INTEGRATION_OPTIONS: JSON.stringify({
						vendor: 'sqlite3',
						directory: join(directory, filter),
						filters: [filter],
						collectAll: true,
						services: false,
						configFile: join(root, 'harness/controls.config.ts'),
					}),
				},
			});

			assert.equal(result.status, code, `${filter}: ${result.stdout}\n${result.stderr}`);
			const report = await readFile(summary, 'utf8');
			assert(report.startsWith(existing));
			assert.match(report, /## Vitest Test Report/);
			assert(report.includes(label), report);
			if (code) assert.match(result.stdout, /EARLY_FAILURE_DETAIL/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('validation and restoration summaries report each check outcome, including incomplete checks', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-workflow-outcomes-'));
	const summary = join(directory, 'summary.md');
	const states = ['success', 'failure', 'cancelled', 'skipped'];

	try {
		for (const [job, checks] of [
			[
				'validation',
				[
					['typecheck', 'Integration types'],
					['harness', 'Harness checks'],
					['lifecycle', 'Process lifecycle'],
					['services', 'Service checks'],
				],
			],
			['restoration', [['restoration', 'Database restoration and cleanup']]],
		]) {
			const step = workflow.jobs[job].steps.find((step) => step.name === `Summarize ${job} checks`);
			assert(step, `${job} summary is missing`);
			assert.equal(step.if, 'always()');

			for (const [id] of checks) {
				assert(
					workflow.jobs[job].steps.some((step) => step.id === id),
					`Missing check: ${id}`
				);

				assert.equal(step.env[`${id.toUpperCase()}_RESULT`], `\${{ steps.${id}.outcome }}`);
			}

			for (let offset = 0; offset < states.length; offset++) {
				const env = { ...process.env, GITHUB_STEP_SUMMARY: summary };
				for (const [index, [id]] of checks.entries())
					env[`${id.toUpperCase()}_RESULT`] = states[(index + offset) % states.length];
				await writeFile(summary, 'Existing summary\n');
				const result = shell(step.run, { env });
				assert.equal(result.status, 0, result.stderr);
				const report = await readFile(summary, 'utf8');
				assert(report.startsWith('Existing summary\n'));
				for (const [id, label] of checks)
					assert(report.includes(`| ${label} | ${env[`${id.toUpperCase()}_RESULT`]} |`), report);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
