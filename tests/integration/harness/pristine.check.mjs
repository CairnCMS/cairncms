import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink, access } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlCheckout, startControl, assertReleased, owners, docker, integrationRoot } from './control-process.mjs';
import { readVendorResult } from './results.mjs';

const read = async (path) => JSON.parse(await readFile(path, 'utf8'));

const present = (path) =>
	access(path).then(
		() => true,
		(error) => {
			if (error.code === 'ENOENT') return false;
			throw error;
		}
	);

const vendor = process.env.TEST_DB ?? 'mysql';

assert(
	['mysql', 'mysql5', 'maria', 'postgres', 'postgres10', 'sqlite3'].includes(vendor),
	'Choose a snapshot-capable vendor'
);

const modes = [
	'runtime-cache',
	'runtime-files',
	'runtime-storage',
	'integrity',
	'config-first',
	'config-later',
	'bootstrap',
	'healthy',
	'creator-failure',
	'capture-cancel',
	'creator-crash',
	'import-cancel',
	'worker-crash',
	'vendor-crash',
	'execution-cancel',
	'body-failure',
	'body-bail',
];

for (const mode of modes)
	test(`pristine restoration: ${mode}`, { timeout: 270000 }, async () => {
		const retained = process.env.INTEGRATION_CONTROL_OUTPUT;
		if (retained) await mkdir(retained, { recursive: true });
		const out = await mkdtemp(join(retained ?? tmpdir(), `pristine-${mode}-`));

		const single =
			mode.startsWith('runtime-') || ['integrity', 'config-first', 'config-later', 'bootstrap'].includes(mode);

		let fixture = mode;
		if (mode === 'integrity' && vendor.startsWith('postgres')) fixture = 'postgres-integrity';
		if (mode === 'integrity' && vendor === 'sqlite3') fixture = 'sqlite-integrity';
		if (mode.startsWith('runtime-')) fixture = 'runtime';
		else if (mode.startsWith('config-')) fixture = 'config';

		const include = single
			? [`harness/controls/pristine-${fixture}.case.ts`]
			: ['harness/controls/pristine-a.case.ts', 'harness/controls/pristine-b.case.ts'];

		const checkout = await controlCheckout(include);
		const record = { vendor, mode, checkout: checkout.directory, complete: false };
		let run, cap, failure;
		const started = performance.now();

		try {
			const env = { CONTROL_DIRECTORY: out, CONTROL_MODE: mode };

			if (vendor === 'sqlite3' && ['capture-cancel', 'creator-crash', 'import-cancel'].includes(mode)) {
				const file = join(checkout.root, 'harness/sqlite-snapshot.mjs');
				const source = await readFile(file, 'utf8');
				const importing = mode === 'import-cancel';

				const point = importing
					? 'await writeFile(filename, input, { mode: 0o600, signal });'
					: 'return readFile(filename, { signal });';

				assert(source.includes(point));
				const marker = importing ? 'import-active.json' : 'capture-active.json';

				const hold = `await writeFile(${JSON.stringify(
					join(out, marker)
				)}, JSON.stringify({pid: process.pid})); await new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), {once:true}); });`;

				await writeFile(
					file,
					source.replace(
						point,
						importing
							? point + hold
							: `{ const captured = await readFile(filename, {signal}); ${hold} return captured; }`
					)
				);
			}

			if (
				(vendor !== 'sqlite3' && ['capture-cancel', 'creator-crash'].includes(mode)) ||
				(vendor.startsWith('postgres') && mode === 'import-cancel')
			) {
				const bin = join(out, 'bin');
				await mkdir(bin);
				await symlink(join(integrationRoot, 'harness/controls/snapshot-tool.mjs'), join(bin, 'docker'));
				env.CONTROL_DOCKER = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
				env.PATH = `${bin}:${process.env.PATH}`;
			}

			const pattern = {
				'config-first': '^a configured first',
				'config-later': '^a configured later',
				'runtime-cache': '^runtime cache',
				'runtime-files': '^runtime file',
				'runtime-storage': '^runtime storage',
			}[mode];

			const args = [
				'run.mjs',
				'--vendor',
				vendor,
				'--workers',
				single ? '1' : '2',
				'--output',
				out,
				...(pattern ? ['-t', pattern] : []),
				...(mode === 'body-bail' ? [] : ['--collect-all']),
			];

			record.command = [process.execPath, ...args];
			run = startControl(args, { cwd: checkout.root, env });
			for (const stream of [run.child.stdout, run.child.stderr])
				stream.on('data', (chunk) => appendFileSync(join(out, 'command.log'), chunk));

			cap = setTimeout(() => {
				record.timedOut = true;
				void run.stop();
			}, 240000);

			await run.poll(() => run.output().includes('Integration results:'));
			record.directory = join(run.output().match(/^Integration results: (.+)$/m)[1], vendor);

			const events = async () =>
				(
					await readFile(join(record.directory, 'provisioning.jsonl'), 'utf8').catch((error) => {
						if (error.code === 'ENOENT') return '';
						throw error;
					})
				)
					.trim()
					.split('\n')
					.filter(Boolean)
					.map(JSON.parse);

			const eventOf = async (type) => (await events()).find((event) => event.type === type);

			if (['capture-cancel', 'creator-crash'].includes(mode)) {
				await run.poll(() => present(join(out, 'capture-active.json')), 150000);
				record.capture = await read(join(out, 'capture-active.json'));
				const owner = await read(join(record.directory, 'pristine.json'));
				assert.equal(await present(join(owner.directory, 'ready.json')), false);
				if (mode === 'creator-crash') process.kill((await eventOf('claimed')).worker, 'SIGKILL');
				else run.child.kill('SIGINT');
			} else if (mode === 'creator-failure') {
				let owner;

				await run.poll(async () => {
					const creator = await eventOf('claimed');
					if (!creator) return false;

					owner = (await owners(record.directory)).find(
						(entry) => entry.database === creator.id && entry.children?.length === 1
					);

					return !!owner;
				});

				record.killedBootstrap = owner.children[0];
				process.kill(record.killedBootstrap, 'SIGKILL');
			} else if (mode === 'import-cancel' && (vendor.startsWith('postgres') || vendor === 'sqlite3')) {
				await run.poll(() => present(join(out, 'import-active.json')), 150000);
				record.importSideEffectObserved = true;
				run.child.kill('SIGTERM');
			} else if (mode === 'import-cancel') {
				await run.poll(() => present(join(out, 'import-ready.json')), 150000);
				const engine = await read(join(record.directory, 'container.json'));

				await run.poll(async () => {
					const result = await docker(
						'docker',
						[
							'exec',
							'--env',
							'MYSQL_PWD=integration',
							engine.id,
							vendor === 'maria' ? 'mariadb' : 'mysql',
							'--user=root',
							'-N',
							'-B',
							'--execute',
							"SELECT COUNT(*) FROM information_schema.tables WHERE table_name='interrupted_restore'",
						],
						{ timeout: 10000 }
					);

					return Number(result.stdout.trim()) > 0;
				});

				record.importSideEffectObserved = true;
				run.child.kill('SIGTERM');
			} else if (['execution-cancel', 'worker-crash', 'vendor-crash'].includes(mode)) {
				await run.poll(
					async () => (await present(join(out, 'a.json'))) && (await present(join(out, 'b.json'))),
					150000
				);

				if (mode === 'execution-cancel') run.child.kill('SIGTERM');
				else if (mode === 'vendor-crash')
					process.kill((await read(join(record.directory, 'pristine.json'))).owner, 'SIGKILL');
				else {
					process.kill((await read(join(out, 'a.json'))).worker, 'SIGKILL');
					await writeFile(join(out, 'release.json'), 'true');
				}
			}

			record.exitCode = await run.done;
			record.seconds = (performance.now() - started) / 1000;
			record.report = await readVendorResult(record.directory, record.exitCode);
			record.events = await events();

			let expected = 1;
			if (single || mode === 'healthy') expected = 0;
			if (mode === 'capture-cancel') expected = 130;
			if (['import-cancel', 'execution-cancel'].includes(mode)) expected = 143;

			assert.equal(record.exitCode, expected, `Unexpected exit; see ${join(out, 'command.log')}`);
			assert(!record.timedOut, 'Control exceeded its 240-second bound');

			if (expected === 0) {
				assert.equal(record.report.complete, true);

				assert.equal(
					record.report.passed,
					mode.startsWith('runtime-')
						? 1
						: {
								integrity: vendor.startsWith('postgres') || vendor === 'sqlite3' ? 8 : 9,
								'config-first': 1,
								'config-later': 1,
								bootstrap: 2,
								healthy: 4,
						  }[mode]
				);

				if (mode === 'healthy') {
					for (const [type, count] of [
						['claimed', 1],
						['published', 1],
						['restored', 3],
					])
						assert.equal(record.events.filter((event) => event.type === type).length, count, type);
				}
			} else {
				assert.equal(record.report.complete, false);
				assert.notEqual(record.report.exitCode, 0);
				if (mode.endsWith('cancel')) assert.equal(record.report.cancelled, true);
				if (['creator-failure', 'creator-crash', 'capture-cancel'].includes(mode))
					assert.equal(
						record.events.some((event) => event.type === 'published'),
						false
					);

				if (mode === 'body-failure') {
					assert.equal(record.report.failures.length, 1);
					assert.equal(record.report.passed, 3);
				}

				if (mode === 'body-bail') {
					assert.deepEqual(record.report.fileErrors, []);
					assert.deepEqual(record.report.blocked, []);

					assert.deepEqual(
						record.report.unexpectedSkips.map((entry) => ({ name: entry.name, result: entry.result })),
						[
							{
								name: 'independent later case b',
								result: { state: 'skipped', note: 'The test run was aborted by the user.' },
							},
						]
					);

					assert.equal(record.report.passed, 1);

					assert.deepEqual(
						record.report.notRun.map((entry) => entry.name),
						['independent later case a']
					);

					assert.equal(record.report.failures.length, 1);
					const failures = new Map(record.report.failures.map((entry) => [entry.name, entry.result.errors]));

					assert.deepEqual(
						failures.get('isolated concurrent restores a')?.map((error) => error.message),
						['DELIBERATE_RESTORE_BODY_FAILURE']
					);

					record.cancellation = await read(join(out, 'b-cancellation.json'));
					assert.deepEqual(record.cancellation, { name: 'TestRunAbortError', reason: 'test-failure' });
				}
			}

			for (const pid of [
				...record.events.filter((event) => event.type === 'tool-started').map((event) => event.pid),
				...Object.values(record.capture ?? {}),
			])
				assert.throws(() => process.kill(pid, 0), /ESRCH/, `Owned tool ${pid} survived`);
			record.complete = true;
		} catch (error) {
			record.error = error.stack;
			failure = error;
		} finally {
			clearTimeout(cap);
			await run?.stop();

			try {
				if (record.directory) await assertReleased(record.directory);
				record.resourcesReleased = true;
			} catch (error) {
				record.complete = false;
				record.cleanupError = error.stack;
				failure = new AggregateError([failure, error].filter(Boolean), 'Restoration control cleanup failed');
			} finally {
				await checkout.remove();
				record.checkoutRemoved = true;
				await writeFile(join(out, 'verification.json'), JSON.stringify(record, null, 2) + '\n');
				if (!retained && record.complete) await rm(out, { recursive: true });
				else process.stdout.write(`Restoration control evidence: ${out}\n`);
			}
		}

		if (failure) throw failure;
	});
