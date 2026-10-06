import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertReleased, docker, integrationRoot, owners, startControl } from './control-process.mjs';
import { cleanupAfterExit } from './exit-cleanup.mjs';

for (const service of ['redis', 'saml', 'storage'])
	for (const mode of ['failure', 'cancel'])
		test(`${service}: ${mode} while starting releases the actual container`, { timeout: 120000 }, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'cairn-service-startup-'));
			const reports = join(directory, 'sqlite3');

			const run = startControl(['harness/vendor.mjs'], {
				env: {
					CONTROL_STARTUP_SERVICE: service,
					INTEGRATION_OPTIONS: JSON.stringify({
						vendor: 'sqlite3',
						directory,
						filters: ['service-startup.case.ts'],
						collectAll: true,
						configFile: join(integrationRoot, 'harness/controls.config.ts'),
					}),
				},
			});

			try {
				if (mode === 'cancel') {
					await run.poll(async () => {
						const owner = (await owners(reports, '.service.json').catch(() => []))[0];
						if (!owner) return false;

						const ps = await docker('docker', [
							'ps',
							'-aq',
							'--filter',
							`label=cairncms.integration.service=${owner.serviceKey}`,
						]);

						return !!ps.stdout.trim();
					});

					run.child.send({ type: 'cancel', signal: 'SIGTERM' });
				}

				assert.equal(await run.done, mode === 'cancel' ? 143 : 1, run.output());
				assert.doesNotMatch(run.output(), /UNEXPECTED_SERVICE_READY/);
				assert.equal((await owners(reports)).length, 0, 'API was provisioned after a failed prerequisite');
				const services = await owners(reports, '.service.json');
				assert.equal(services.length, 1);
				const owner = services[0];

				const diagnostic = JSON.parse(
					await readFile(join(reports, `${owner.serviceKey}.service.json.startup.json`), 'utf8')
				);

				assert.equal(diagnostic.id, owner.id);
				assert.match(diagnostic.error, /CAIRN_CONTROL_THIS_READINESS_MARKER_IS_NEVER_EMITTED/);
				if (mode === 'failure') assert.match(run.output(), /CAIRN_CONTROL_THIS_READINESS_MARKER_IS_NEVER_EMITTED/);
			} finally {
				await run.stop();

				try {
					await assertReleased(reports);
				} finally {
					// Assert native teardown before recovering leftovers from a failed control.
					const cleanup = await cleanupAfterExit(reports);
					await rm(directory, { recursive: true, force: true });
					assert.deepEqual(cleanup.errors, []);
				}
			}
		});
