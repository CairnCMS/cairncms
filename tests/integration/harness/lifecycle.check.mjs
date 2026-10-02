import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { mkdtemp, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = process.env.TEST_DB || 'sqlite3';

async function exercise(name, intervene, expected, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-lifecycle-'));
	const { env = {}, ...runnerOptions } = options;

	const child = spawn(process.execPath, ['harness/vendor.mjs'], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		env: {
			...process.env,
			...env,
			INTEGRATION_OPTIONS: JSON.stringify({
				vendor,
				directory,
				filters: [name],
				collectAll: false,
				configFile: join(root, 'harness/controls.config.ts'),
				...runnerOptions,
			}),
		},
	});

	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (data) => {
			output += data;
		});

	const done = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', resolve);
	});

	const poll = async (condition) => {
		const end = performance.now() + 90_000;

		while (performance.now() < end) {
			if (await condition()) return;
			if (child.exitCode !== null) throw new Error(`Child exited before intervention:\n${output}`);
			await setTimeout(20);
		}

		throw new Error(`Condition timed out:\n${output}`);
	};

	const owners = async () => {
		let files;

		try {
			files = await readdir(join(directory, vendor));
		} catch {
			return [];
		}

		const result = [];

		for (const file of files.filter((f) => f.endsWith('.owner.json'))) {
			try {
				result.push(JSON.parse(await readFile(join(directory, vendor, file), 'utf8')));
			} catch {
				/* A write can be in progress. */
			}
		}

		return result;
	};

	try {
		await intervene({ child, poll, owners, directory, output: () => output });
		const afterIntervention = performance.now();
		assert.equal(await done, expected, output);
		assert(performance.now() - afterIntervention < 20_000, output);

		for (const owner of await owners()) {
			await assert.rejects(access(owner.directory));
			for (const pid of owner.children ?? []) assert.throws(() => process.kill(pid, 0), /ESRCH/);
		}

		return output;
	} finally {
		child.kill('SIGKILL');
		await rm(directory, { recursive: true, force: true });
	}
}

test('bootstrap exit releases its owned database and files', { timeout: 120_000 }, async () => {
	const output = await exercise(
		'cancel.case.ts',
		async ({ poll, owners }) => {
			await poll(async () => {
				const owner = (await owners())[0];
				if (!owner?.children?.[0]) return false;
				process.kill(owner.children[0], 'SIGKILL');
				return true;
			});
		},
		1
	);

	assert.match(output, /bootstrap exited/);
});

test('API exit during readiness is reported immediately', { timeout: 120_000 }, async () => {
	const output = await exercise(
		'cancel.case.ts',
		async ({ poll, owners }) => {
			await poll(async () => {
				const owner = (await owners())[0];
				if (!owner?.children?.[1]) return false;
				process.kill(owner.children[1], 'SIGKILL');
				return true;
			});
		},
		1
	);

	assert.match(output, /startup exited/);
});

test('API exit settles a pending real HTTP request', { timeout: 120_000 }, async () => {
	const output = await exercise(
		'crash.case.ts',
		async ({ poll, output }) => {
			await poll(() => output().includes('startup:'));
		},
		1
	);

	assert.match(output, /socket hang up|ECONNRESET|ECONNREFUSED/);
});

for (const phase of ['bootstrap', 'execution'])
	test(`Ctrl+C during ${phase} cleans up`, { timeout: 120_000 }, async () => {
		await exercise(
			'cancel.case.ts',
			async ({ child, poll, owners, output }) => {
				await poll(async () =>
					phase === 'bootstrap' ? !!(await owners())[0]?.children?.[0] : output().includes('EXECUTION_READY')
				);

				child.send({ type: 'cancel', signal: 'SIGINT' });
			},
			130
		);
	});

test('public command propagates Ctrl+C and disposes its owned environment', { timeout: 120_000 }, async () => {
	const child = spawn(process.execPath, ['run.mjs', 'routes/items/no-relation.test.ts', '--vendor', vendor], {
		cwd: root,
		env: { ...process.env, CI: '' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let output = '';
	let interrupted = false;
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (data) => {
			output += data;

			if (!interrupted && output.includes('startup:')) {
				interrupted = true;
				child.kill('SIGINT');
			}
		});

	const code = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', resolve);
	});

	assert.equal(code, 130, output);
	const directory = output.match(/^Integration results: (.+)$/m)?.[1];
	assert(directory, output);

	for (const file of await readdir(join(directory, vendor))) {
		if (!file.endsWith('.owner.json')) continue;
		const owner = JSON.parse(await readFile(join(directory, vendor, file), 'utf8'));
		await assert.rejects(access(owner.directory));
		for (const pid of owner.children ?? []) assert.throws(() => process.kill(pid, 0), /ESRCH/);
	}

	await rm(directory, { recursive: true, force: true });
});

test('an API exit without another request cannot produce a green file', { timeout: 120_000 }, async () => {
	const output = await exercise(
		'late-exit.case.ts',
		async ({ poll, output }) => {
			await poll(() => output().includes('startup:'));
		},
		1
	);

	assert.match(output, /api-entry.mjs exited SIGKILL/);
});

test(
	'loss of the shared engine stops its vendor with an infrastructure failure',
	{ timeout: 120_000, skip: vendor !== 'postgres' },
	async () => {
		const output = await exercise(
			'cancel.case.ts',
			async ({ poll, directory, output }) => {
				await poll(() => output().includes('EXECUTION_READY'));
				const { id } = JSON.parse(await readFile(join(directory, vendor, 'container.json'), 'utf8'));
				await promisify(execFile)('docker', ['kill', id]);
			},
			1
		);

		assert.match(output, /Database engine\/log connection lost/);
	}
);

// A dead per-file API must not produce a request-error cascade in collect-all mode.
test('collect-all blocks later cases that depend on a dead API', { timeout: 120_000 }, async () => {
	const output = await exercise(
		'crash-collect.case.ts',
		async ({ poll, output }) => {
			await poll(() => output().includes('startup:'));
		},
		1,
		{ collectAll: true }
	);

	assert.match(output, /CONTROL_API_CRASH/);
	assert.doesNotMatch(output, /^CONTROL_LATER_EXECUTED$/m);
	assert.match(output, /1 skipped/);
});

for (const [collectAll, color] of [
	[false, '0'],
	[true, '0'],
	[true, '1'],
]) {
	test(
		`missing hook preserves its setup error through afterEach (${
			collectAll ? 'collect-all' : 'fail-fast'
		}, color=${color})`,
		{ timeout: 120_000 },
		async () => {
			const output = await exercise(
				'missing-hook.case.ts',
				async ({ poll, output }) => {
					// Measure failure cleanup after the missing fixture is reported,
					// not from before database/bootstrap provisioning begins.
					await poll(() => output().includes('bootstrap failed; diagnostics:'));
				},
				1,
				{ collectAll, env: { FORCE_COLOR: color } }
			);

			assert.match(output, /ENOENT/);
			assert.match(output, /1 failed/);
			if (collectAll) assert.match(stripVTControlCharacters(output), /1 failed \| 2 skipped/);
			assert.doesNotMatch(output, /MISSING_HOOK_BODY_EXECUTED/);
		}
	);
}
