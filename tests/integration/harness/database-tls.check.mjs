import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startControl, integrationRoot, assertReleased, owners, controlCheckout, docker } from './control-process.mjs';
import { readVendorResult } from './results.mjs';
import { cleanupAfterExit } from './exit-cleanup.mjs';

async function control(vendor, mode, use, env = {}, root = integrationRoot) {
	const retained = process.env.INTEGRATION_CONTROL_OUTPUT;
	if (retained) await mkdir(retained, { recursive: true });
	const directory = await mkdtemp(join(retained ?? tmpdir(), `tls-${vendor}-${mode}-`));
	const reports = join(directory, vendor);

	const run = startControl(['harness/vendor.mjs'], {
		detached: true,
		cwd: root,
		env: {
			...env,
			CONTROL_DATABASE_TLS: mode,
			INTEGRATION_OPTIONS: JSON.stringify({
				vendor,
				directory,
				collectAll: true,
				filters: [mode === 'overlap' ? 'database-tls-overlap.case.ts' : 'database-tls.case.ts'],
				configFile: join(root, 'harness/controls.config.ts'),
			}),
		},
	});

	try {
		await use(run, reports);
	} finally {
		await run.stop();
		await writeFile(join(directory, 'runner.log'), run.output());
		const cleanup = await cleanupAfterExit(reports, run.child.pid);
		assert.deepEqual(cleanup.errors, [], JSON.stringify(cleanup));
		await assertReleased(reports);
		if (!retained) await rm(directory, { recursive: true, force: true });
	}
}

for (const vendor of ['postgres18', 'mysql84', 'maria1011']) {
	test(`owned TLS ${vendor} connects the compiled API and cleans up`, { timeout: 180000 }, async () => {
		await control(vendor, 'healthy', async (run, reports) => {
			assert.equal(await run.done, 0, run.output());
			const result = await readVendorResult(reports, 0);
			assert.equal(result.passed, 1, JSON.stringify(result));
			assert.equal(result.complete, true, JSON.stringify(result));
			await assertReleased(reports);
		});
	});

	test(`owned TLS ${vendor} rejects a trusted certificate for another hostname`, { timeout: 180000 }, async () => {
		await control(vendor, 'identity', async (run, reports) => {
			assert.equal(await run.done, 0, run.output());
			assert.equal((await readVendorResult(reports, 0)).passed, 1);
			await assertReleased(reports);
		});
	});
}

test(
	'overlapping TLS environments preserve each other and the ordinary pristine store',
	{ timeout: 180000 },
	async () => {
		await control('postgres18', 'overlap', async (run, reports) => {
			assert.equal(await run.done, 0, run.output());
			assert.equal((await readVendorResult(reports, 0)).passed, 1);
			await assertReleased(reports);
		});
	}
);

for (const mode of ['readiness', 'startup-cancel', 'startup-owner-loss', 'probe-timeout']) {
	test(`TLS ${mode} retains diagnostics and releases owned resources`, { timeout: 180000 }, async () => {
		const checkout = await controlCheckout(['harness/controls/database-tls.case.ts']);

		try {
			const file = join(checkout.root, 'fixtures/database-tls.ts');
			const source = await readFile(file, 'utf8');
			const marker = 'wait: Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]),';
			assert(source.includes(marker));

			if (mode !== 'probe-timeout') {
				await writeFile(
					file,
					source.replace(marker, "wait: Wait.forLogMessage('TLS_CONTROL_READINESS'), startupTimeoutMs: 3000,")
				);
			} else {
				const entry = join(checkout.root, 'harness/database-tls-probe.mjs');
				await writeFile(entry, "process.stdout.write('TLS_CONTROL_PROBE_STALLED\\n'); setInterval(() => {}, 1000);\n");
			}

			await control(
				'postgres18',
				'healthy',
				async (run, reports) => {
					if (mode.startsWith('startup-')) {
						await run.poll(async () => {
							const service = (await owners(reports, '.service.json'))[0];
							if (!service) return false;

							const result = await docker('docker', [
								'ps',
								'-q',
								'--filter',
								`label=cairncms.integration.service=${service.serviceKey}`,
							]);

							return !!result.stdout.trim();
						});

						if (mode === 'startup-owner-loss') run.child.kill('SIGKILL');
						else run.child.send({ type: 'cancel', signal: 'SIGTERM' });
					}

					assert.notEqual(await run.done, 0, run.output());
					if (mode === 'readiness') assert.match(run.output(), /TLS_CONTROL_READINESS/);
					if (mode === 'probe-timeout') assert.match(run.output(), /CLI exceeded 25000ms/);
					if (mode !== 'startup-owner-loss') await assertReleased(reports);
				},
				{},
				checkout.root
			);
		} finally {
			await checkout.remove();
		}
	});
}

test('TLS fixture assertion failures retain failure and release resources', { timeout: 180000 }, async () => {
	await control('postgres18', 'failure', async (run, reports) => {
		assert.equal(await run.done, 1, run.output());
		assert.match(run.output(), /TLS_CONTROL_FAILURE/);
		assert.equal((await readVendorResult(reports, 1)).failures.length, 1);
		await assertReleased(reports);
	});
});

test('TLS certificate generation failure is reported and cleaned up', { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-tls-tools-'));

	try {
		await writeFile(join(directory, 'openssl'), '#!/bin/sh\necho TLS_CERTIFICATE_CONTROL_FAILURE >&2\nexit 17\n', {
			mode: 0o755,
		});

		await control(
			'postgres18',
			'healthy',
			async (run, reports) => {
				assert.equal(await run.done, 1, run.output());
				assert.match(run.output(), /TLS_CERTIFICATE_CONTROL_FAILURE/);
				await assertReleased(reports);
			},
			{ PATH: `${directory}:${process.env.PATH}` }
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const force of [false, true]) {
	test(
		`TLS certificate generation ${force ? 'owner loss' : 'cancellation'} releases children and files`,
		{ timeout: 90000 },
		async () => {
			const directory = await mkdtemp(join(tmpdir(), 'cairn-tls-tools-'));

			try {
				await writeFile(join(directory, 'openssl'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, {
					mode: 0o755,
				});

				await control(
					'postgres18',
					'healthy',
					async (run, reports) => {
						await run.poll(async () =>
							(await owners(reports)).some((owner) => owner.directory.includes('-tls-') && owner.children?.length)
						);

						if (force) run.child.kill('SIGKILL');
						else run.child.send({ type: 'cancel', signal: 'SIGTERM' });
						const code = await run.done;
						assert.notEqual(code, 0, run.output());
						if (!force) await assertReleased(reports);
					},
					{ PATH: `${directory}:${process.env.PATH}` }
				);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
}
