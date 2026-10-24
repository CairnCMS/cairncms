import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wait } from 'testcontainers';
import { RecordedContainer } from './recorded-container.mjs';
import { databaseVendors } from './database-vendors.mjs';
import { probeSignal, recordEngine } from './engine-version.mjs';

const definition = databaseVendors.mysql84;
const docker = promisify(execFile);

test(
	'the engine probe reads a real engine, keeps client errors, and ends a stalled command',
	{ timeout: 180_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-engine-version-'));
		const record = join(directory, 'container.json');
		let container;
		let id;

		try {
			await writeFile(record, JSON.stringify({ image: definition.image }));

			container = await new RecordedContainer(definition.image, record)
				.withEnvironment(definition.environment)
				.withCommand(definition.command)
				.withExposedPorts(definition.port)
				.withHealthCheck({ test: definition.health, interval: 1000, timeout: 1000, retries: 60 })
				.withWaitStrategy(Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]))
				.withStartupTimeout(90_000)
				.start();

			id = container.getId();
			const events = [];
			let stderr = '';

			const probe = (options) =>
				recordEngine({
					id,
					definition,
					signal: probeSignal(new AbortController().signal),
					record: async (type, detail) => {
						events.push({ type, ...detail });
					},
					stderr: (chunk) => {
						stderr += chunk;
					},
					...options,
				});

			assert.match(await probe(), /^8\.4\.\d+$/);
			assert.match(stderr, /Using a password on the command line/);

			const wrong = { ...definition, environment: { ...definition.environment, MYSQL_ROOT_PASSWORD: 'wrong' } };
			await assert.rejects(probe({ definition: wrong }), /Engine version probe failed: .*exit=1.*Access denied/s);

			events.length = 0;
			const started = performance.now();

			await assert.rejects(
				probe({ command: ['sh', '-c', 'sleep 60'], signal: probeSignal(new AbortController().signal, 2_000) }),
				/Engine version probe exceeded its deadline/
			);

			assert(performance.now() - started < 10_000);

			assert.deepEqual(
				events.map((event) => event.type),
				['tool-started', 'tool-closed']
			);

			assert.throws(() => process.kill(events[0].pid, 0), /ESRCH/);
		} finally {
			await container?.stop();
			await rm(directory, { recursive: true, force: true });
		}

		await assert.rejects(docker('docker', ['inspect', id]), /no such object/i);
	}
);
