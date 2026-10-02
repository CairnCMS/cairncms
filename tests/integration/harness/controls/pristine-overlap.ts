import { expect, inject } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createApiTest, withEnvironment } from '../../fixtures/environment';
import { snapshotHash } from '../snapshot.mjs';
import { initializeFixtures } from '../fixture-setup.mjs';

export function register(side: 'a' | 'b') {
	initializeFixtures();
	const test = createApiTest();
	const out = process.env.CONTROL_DIRECTORY!;
	const mode = process.env.CONTROL_MODE!;
	const marker = (name: string) => join(out, name + '.json');

	const until = async (name: string, signal: AbortSignal) => {
		const deadline = performance.now() + 90000;

		while (performance.now() < deadline) {
			signal.throwIfAborted();

			try {
				return JSON.parse(await readFile(marker(name), 'utf8'));
			} catch (error) {
				if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
					throw error;
			}

			await delay(25, undefined, { signal });
		}

		throw new Error('Control barrier timed out');
	};

	test(`isolated concurrent restores ${side}`, async ({ api, cancellationSignal: signal }) => {
		await api.database.schema.createTable('same_fixture_name', (table) => table.string('value').primary());
		await api.database('same_fixture_name').insert({ value: side });
		await writeFile(join(api.directory, 'uploads', 'same-file.txt'), side);

		const identity = (instance: typeof api) => ({
			worker: process.pid,
			api: instance.child.pid,
			directory: instance.directory,
			url: instance.url,
			database:
				instance.database.client.config.connection.database ?? instance.database.client.config.connection.filename,
		});

		await writeFile(marker(side), JSON.stringify(identity(api)));
		const peer = await until(side === 'a' ? 'b' : 'a', signal);
		for (const key of ['worker', 'api', 'directory', 'url', 'database'] as const)
			expect(peer[key]).not.toBe(identity(api)[key]);
		if (['execution-cancel', 'worker-crash', 'vendor-crash'].includes(mode)) await until('release', signal);

		if (mode === 'import-cancel' && ['mysql', 'mysql5', 'maria'].includes(inject('integration').vendor)) {
			if (side === 'a') {
				const cache = inject('integration').pristine!.directory;
				const metadata = JSON.parse(await readFile(join(cache, 'ready.json'), 'utf8'));

				const sql = Buffer.concat([
					Buffer.from('CREATE TABLE interrupted_restore (id int PRIMARY KEY); SELECT SLEEP(60);\n'),
					await readFile(join(cache, 'pristine.snapshot')),
				]);

				await writeFile(join(cache, 'pristine.snapshot'), sql);
				await writeFile(join(cache, 'ready.json'), JSON.stringify({ ...metadata, dumpHash: snapshotHash(sql) }));
				await writeFile(marker('import-ready'), 'true');
			}

			await until('import-ready', signal);
		}

		await withEnvironment(
			inject('integration'),
			false,
			async (clone) => {
				expect(
					clone.database.client.config.connection.database ?? clone.database.client.config.connection.filename
				).not.toBe(identity(api).database);

				expect(await clone.database.schema.hasTable('same_fixture_name')).toBe(false);
				await clone.database.schema.createTable('same_fixture_name', (table) => table.string('value').primary());
				await clone.database('same_fixture_name').insert({ value: 'clone-' + side });
				await writeFile(join(clone.directory, 'uploads', 'same-file.txt'), 'clone-' + side);
				await writeFile(marker(side + '-clone'), JSON.stringify(identity(clone)));
				await until((side === 'a' ? 'b' : 'a') + '-clone', signal);
				await api.database.schema.dropTable('same_fixture_name');
				expect(await clone.database('same_fixture_name').select('value')).toEqual([{ value: 'clone-' + side }]);
				expect(await readFile(join(api.directory, 'uploads', 'same-file.txt'), 'utf8')).toBe(side);
				expect(await readFile(join(clone.directory, 'uploads', 'same-file.txt'), 'utf8')).toBe('clone-' + side);
			},
			signal
		);

		expect(
			(await api.database('directus_users').select('email')).some((row) => row.email === 'bootstrap@example.com')
		).toBe(true);

		if (mode === 'body-bail' && side === 'a') await until('b-awaiting-cancellation', signal);
		if (['body-failure', 'body-bail'].includes(mode) && side === 'a')
			throw new Error('DELIBERATE_RESTORE_BODY_FAILURE');
	}, 180000);

	test(`independent later case ${side}`, async ({ api, signal, cancellationSignal }) => {
		expect((await fetch(api.url + '/server/ping')).status).toBe(200);

		if (mode === 'body-bail' && side === 'b') {
			// The peer must be active before the first failure triggers native cancellation.
			const aborted = once(signal, 'abort');
			await writeFile(marker('b-awaiting-cancellation'), 'true');
			await aborted;
			expect(cancellationSignal.aborted).toBe(true);

			await writeFile(
				marker('b-cancellation'),
				JSON.stringify({ name: signal.reason.name, reason: signal.reason.reason })
			);

			throw signal.reason;
		}
	});
}
