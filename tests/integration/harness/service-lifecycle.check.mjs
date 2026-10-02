import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { readVendorResult } from './results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

for (const service of ['redis', 'saml', 'storage']) {
	for (const mode of ['bootstrap-exit', 'cancel-bootstrap', 'cancel-ready', 'late-exit']) {
		test(`${service}: ${mode} removes its API and service`, { timeout: 120_000 }, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'cairn-service-lifecycle-'));
			const reports = join(directory, 'sqlite3');
			let output = '';

			const child = spawn(process.execPath, ['harness/vendor.mjs'], {
				cwd: root,
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
				env: {
					...process.env,
					CONTROL_SERVICE_MODE: mode,
					INTEGRATION_OPTIONS: JSON.stringify({
						vendor: 'sqlite3',
						directory,
						filters: [`${service}-lifecycle.case.ts`],
						collectAll: true,
						configFile: join(root, 'harness/controls.config.ts'),
					}),
				},
			});

			for (const stream of [child.stdout, child.stderr])
				stream.on('data', (chunk) => {
					output += chunk;
				});

			const done = new Promise((resolve, reject) => {
				child.once('exit', resolve);
				child.once('error', reject);
			});

			const records = async (suffix) => {
				const files = await readdir(reports).catch(() => []);
				return (
					await Promise.all(
						files
							.filter((file) => file.endsWith(suffix))
							.map((file) =>
								readFile(join(reports, file), 'utf8')
									.then(JSON.parse)
									.catch(() => null)
							)
					)
				).filter(Boolean);
			};

			try {
				if (mode !== 'late-exit') {
					const until = performance.now() + 90_000;
					let intervened = false;

					while (performance.now() < until) {
						if (mode === 'cancel-ready' && output.includes('SERVICE_EXECUTION_READY')) {
							child.send({ type: 'cancel', signal: 'SIGTERM' });
							intervened = true;
							break;
						}

						if (mode !== 'cancel-ready') {
							const owner = (await records('.owner.json'))[0];

							if (owner?.children?.[0]) {
								if (mode === 'bootstrap-exit') process.kill(owner.children[0], 'SIGKILL');
								else child.send({ type: 'cancel', signal: 'SIGTERM' });
								intervened = true;
								break;
							}
						}

						assert.equal(child.exitCode, null, output);
						await setTimeout(20);
					}

					assert(intervened, output);
				}

				const code = await done;
				assert.equal(code, mode.startsWith('cancel') ? 143 : 1, output);
				assert.notEqual((await readVendorResult(reports, code)).exitCode, 0);
				const services = await records('.service.json');
				assert.equal(services.length, 1, output);

				for (const owner of services) {
					assert.equal(owner.removed, true, `${JSON.stringify(owner)}\n${output}`);
					await assert.rejects(exec('docker', ['container', 'inspect', owner.id]), /No such/);
				}

				for (const owner of await records('.owner.json')) {
					for (const pid of owner.children ?? []) assert.throws(() => process.kill(pid, 0), /ESRCH/);
					await assert.rejects(readFile(join(owner.directory, 'package.json')), /ENOENT/);
				}
			} finally {
				child.kill('SIGKILL');
				for (const owner of await records('.service.json'))
					await exec('docker', ['rm', '-f', '-v', owner.id]).catch(() => {});
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
}
