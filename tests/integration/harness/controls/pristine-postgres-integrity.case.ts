import { test, expect, inject } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import knex from 'knex';
import { withEnvironment } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';
import { ensureTemplate } from './pristine-support';

initializeFixtures();

test('template refuses connections while independent clones retain PostGIS and sequences', async ({ signal }) => {
	const runtime = inject('integration');
	await ensureTemplate(runtime, signal);
	const { template } = JSON.parse(await readFile(join(runtime.pristine!.directory, 'pristine.snapshot'), 'utf8'));

	const blocked = knex({
		client: 'pg',
		connection: { ...runtime.connection, database: template },
		pool: { min: 0, max: 1 },
	});

	try {
		await expect(blocked.raw('SELECT 1')).rejects.toThrow(/not currently accepting connections/);
	} finally {
		await blocked.destroy();
	}

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			expect((await api.database.raw('SELECT ST_AsText(ST_Point(1, 2)) AS point')).rows).toEqual([
				{ point: 'POINT(1 2)' },
			]);

			const result = await api
				.database('directus_activity')
				.insert({ action: 'create', collection: 'fixture', item: 'one' })
				.returning('id');

			expect(result[0].id).toBeGreaterThan(0);
		},
		signal
	);
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
		const bytes = await readFile(join(directory, 'pristine.snapshot'));
		const { template } = JSON.parse(bytes.toString());
		const metadata = JSON.parse(original.toString());
		let entered = false;

		const admin = knex({
			client: 'pg',
			connection: { ...runtime.connection, database: 'postgres' },
			pool: { min: 0, max: 1 },
		});

		let source: ReturnType<typeof knex> | undefined;
		let sequence: { last_value: string; is_called: boolean } | undefined;

		try {
			if (fault === 'mixed-build') metadata.buildHash = '0'.repeat(64);
			if (fault === 'corrupt-inventory') metadata.snapshotHash = '0'.repeat(64);
			if (fault === 'malformed-hash') metadata.dumpHash = 'invalid-template-value';
			if (fault === 'corrupt-dump')
				await writeFile(join(directory, 'pristine.snapshot'), Buffer.concat([bytes, Buffer.from(' ')]));

			if (fault.startsWith('changed-')) {
				await admin.raw('ALTER DATABASE ?? ALLOW_CONNECTIONS true', [template]);

				source = knex({
					client: 'pg',
					connection: { ...runtime.connection, database: template },
					pool: { min: 0, max: 1 },
				});

				if (fault === 'changed-schema')
					await source.schema.createTable('unexpected_template_table', (table) => table.integer('id'));
				else {
					sequence = await source('directus_activity_id_seq').select('last_value', 'is_called').first();
					await source.raw("SELECT setval('directus_activity_id_seq', 900000, true)");
				}

				await source.destroy();
				source = undefined;
				await admin.raw('ALTER DATABASE ?? ALLOW_CONNECTIONS false', [template]);
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
			await source?.destroy();

			if (fault.startsWith('changed-')) {
				await admin.raw('ALTER DATABASE ?? ALLOW_CONNECTIONS true', [template]);

				const repair = knex({
					client: 'pg',
					connection: { ...runtime.connection, database: template },
					pool: { min: 0, max: 1 },
				});

				try {
					if (fault === 'changed-schema') await repair.schema.dropTableIfExists('unexpected_template_table');
					else if (sequence)
						await repair.raw("SELECT setval('directus_activity_id_seq', ?, ?)", [
							sequence.last_value,
							sequence.is_called,
						]);
				} finally {
					await repair.destroy();
				}

				await admin.raw('ALTER DATABASE ?? ALLOW_CONNECTIONS false', [template]);
			}

			await admin.destroy();
			await writeFile(join(directory, 'ready.json'), original);
			await writeFile(join(directory, 'pristine.snapshot'), bytes);
		}
	}, 120000);
}
