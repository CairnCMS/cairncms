import { test, expect, inject } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import knex from 'knex';
import { withEnvironment } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';
import { snapshotHash } from '../snapshot.mjs';
import { ensureTemplate } from './pristine-support';

initializeFixtures();

test('independent database files retain foreign keys and generated identities', async ({ signal }) => {
	const runtime = inject('integration');
	await ensureTemplate(runtime, signal);
	const snapshot = join(runtime.pristine!.directory, 'pristine.snapshot');
	expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
	const before = snapshotHash(await readFile(snapshot));

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			expect(await api.database.raw('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);

			const ids = await api
				.database('directus_activity')
				.insert({ action: 'create', collection: 'fixture', item: 'one' });

			expect(ids[0]).toBeGreaterThan(0);
		},
		signal
	);

	expect(snapshotHash(await readFile(snapshot))).toBe(before);
}, 120000);

for (const [fault, message] of [
	['mixed-build', 'Pristine build mismatch'],
	['corrupt-dump', 'Pristine dump digest mismatch'],
	['corrupt-inventory', 'Pristine inventory digest mismatch'],
	['malformed-metadata', 'Invalid pristine metadata'],
	['malformed-hash', 'Invalid pristine metadata'],
	['changed-schema', 'Restored database differs'],
	['changed-sequence', 'Restored database differs'],
]) {
	test(`rejects ${fault} before exposing an API`, async ({ signal }) => {
		const runtime = inject('integration');
		await ensureTemplate(runtime, signal);
		const directory = runtime.pristine!.directory;
		const original = await readFile(join(directory, 'ready.json'));
		const snapshot = join(directory, 'pristine.snapshot');
		const bytes = await readFile(snapshot);
		const metadata = JSON.parse(original.toString());
		let entered = false;

		try {
			if (fault === 'mixed-build') metadata.buildHash = '0'.repeat(64);
			if (fault === 'corrupt-inventory') metadata.snapshotHash = '0'.repeat(64);
			if (fault === 'malformed-hash') metadata.dumpHash = 'invalid-template-value';
			if (fault === 'corrupt-dump') await writeFile(snapshot, Buffer.concat([bytes, Buffer.from('changed')]));

			if (fault.startsWith('changed-')) {
				const source = knex({
					client: 'sqlite3',
					connection: { filename: snapshot },
					useNullAsDefault: true,
					pool: { min: 0, max: 1 },
				});

				try {
					if (fault === 'changed-schema')
						await source.schema.createTable('unexpected_template_table', (table) => table.integer('id'));
					else await source('sqlite_sequence').where({ name: 'directus_activity' }).update({ seq: 900000 });
				} finally {
					await source.destroy();
				}

				metadata.dumpHash = snapshotHash(await readFile(snapshot));
			}

			await writeFile(
				join(directory, 'ready.json'),
				fault === 'malformed-metadata' ? 'invalid json' : JSON.stringify(metadata)
			);

			await expect(
				withEnvironment(
					runtime,
					false,
					async () => {
						entered = true;
					},
					signal
				)
			).rejects.toThrow(message);

			expect(entered).toBe(false);
		} finally {
			await writeFile(snapshot, bytes);
			await writeFile(join(directory, 'ready.json'), original);
		}
	}, 120000);
}
