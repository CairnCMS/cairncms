import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContainerRuntimeClient, Wait } from 'testcontainers';
import { RecordedContainer } from './recorded-container.mjs';

const image = 'redis@sha256:b362b5dff9d14d961dc3352db4776aba6a8c53ca2661d7c74ad2c121f82cdaea';

test(
	'port-binding failure records early ownership, retains evidence and removes the container',
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cairn-startup-control-'));
		const record = join(directory, 'container.json');
		await writeFile(record, JSON.stringify({ control: 'no-network', image }));
		const client = await getContainerRuntimeClient();
		let id;

		try {
			const engine = new RecordedContainer(image, record)
				.withNetworkMode('none')
				.withExposedPorts(6379)
				.withWaitStrategy(Wait.forListeningPorts())
				.withStartupTimeout(15_000);

			await assert.rejects(engine.start(), /container ports to be bound/);
			id = JSON.parse(await readFile(record, 'utf8')).id;
			assert.match(id, /^[a-f0-9]{64}$/);
			const failure = JSON.parse(await readFile(record + '.startup.json', 'utf8'));
			assert.equal(failure.id, id);
			assert.equal(failure.state.Running, true);
			assert.equal(failure.networkMode, 'none');
			assert.deepEqual(failure.actualPorts['6379/tcp'] ?? [], [], JSON.stringify(failure));
			assert((await readFile(record + '.startup.docker-log')).includes('Ready to accept connections'));
			await assert.rejects(client.container.inspect(client.container.getById(id)), { statusCode: 404 });
		} finally {
			// Control cleanup remains exact-ID scoped even if an assertion fails.
			id ??= JSON.parse(await readFile(record, 'utf8')).id;
			if (id)
				await client.container
					.getById(id)
					.remove({ force: true, v: true })
					.catch((error) => {
						if (error.statusCode !== 404) throw error;
					});
			await rm(directory, { recursive: true, force: true });
		}
	}
);

test('readiness failure retains running container evidence before library removal', { timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-readiness-control-'));
	const record = join(directory, 'container.json');
	await writeFile(record, JSON.stringify({ control: 'closed-port', image }));
	const client = await getContainerRuntimeClient();
	let id;

	try {
		const engine = new RecordedContainer(image, record)
			.withExposedPorts(6380)
			.withWaitStrategy(Wait.forListeningPorts())
			.withStartupTimeout(2000);

		await assert.rejects(engine.start(), /Port .* not bound/);
		id = JSON.parse(await readFile(record, 'utf8')).id;
		const failure = JSON.parse(await readFile(record + '.startup.json', 'utf8'));
		assert.equal(failure.id, id);
		assert.equal(failure.state.Running, true);
		assert(failure.actualPorts['6380/tcp'].length > 0);
		assert((await readFile(record + '.startup.docker-log')).includes('Ready to accept connections'));
		await assert.rejects(client.container.inspect(client.container.getById(id)), { statusCode: 404 });
	} finally {
		id ??= JSON.parse(await readFile(record, 'utf8')).id;
		if (id)
			await client.container
				.getById(id)
				.remove({ force: true, v: true })
				.catch((error) => {
					if (error.statusCode !== 404) throw error;
				});
		await rm(directory, { recursive: true, force: true });
	}
});
