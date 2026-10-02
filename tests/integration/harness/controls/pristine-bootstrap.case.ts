import { test, expect, inject } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withEnvironment } from '../../fixtures/environment';
import { snapshotHash, snapshotInventory } from '../snapshot.mjs';
import { initializeFixtures } from '../fixture-setup.mjs';
import { ensureTemplate, canonicalFresh } from './pristine-support';

initializeFixtures();

test('explicit fresh bootstrap and restoration have equivalent schema and data after login', async ({ signal }) => {
	const runtime = inject('integration');

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			if (!api.adminToken) throw new Error('Bootstrap login missing');
		},
		signal
	);

	let restored: string | undefined;

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			restored = canonicalFresh(
				await snapshotInventory(api.database, api.database.client.config.connection.database, signal, {
					vendor: runtime.vendor,
				})
			);
		},
		signal
	);

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			const fresh = canonicalFresh(
				await snapshotInventory(api.database, api.database.client.config.connection.database, signal, {
					vendor: runtime.vendor,
				})
			);

			expect(fresh).toBe(restored);
		},
		signal,
		{ bootstrap: 'fresh' }
	);
}, 180000);

test('a custom migration executes through bootstrap and leaves the template unchanged', async ({ signal }) => {
	const runtime = inject('integration');
	await ensureTemplate(runtime, signal);
	const path = join(runtime.pristine!.directory, 'ready.json');
	const original = snapshotHash(await readFile(path));

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			expect(await api.database('integration_migration_control').select('value')).toEqual([{ value: 'migration-ran' }]);

			expect((await api.database('directus_migrations').where({ version: '29990101A' }).first()).name).toBe(
				'Control Marker'
			);
		},
		signal,
		{ migrations: ['29990101A-control-marker.cjs'] }
	);

	expect(snapshotHash(await readFile(path))).toBe(original);
}, 120000);
