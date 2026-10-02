import { test, expect, inject } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withEnvironment } from '../../fixtures/environment';
import { snapshotHash } from '../snapshot.mjs';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('a configured first environment bootstraps without creating a template', async ({ signal }) => {
	const runtime = inject('integration');

	await withEnvironment(
		runtime,
		false,
		async (api) => {
			expect((await api.database('directus_settings').first()).project_name).toBe('Configured first project');
			await expect(access(join(runtime.pristine!.directory, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
		},
		signal,
		{ env: { PROJECT_NAME: 'Configured first project' } }
	);
}, 120000);

test('a configured later environment bootstraps without changing the template', async ({ signal }) => {
	const runtime = inject('integration');

	await withEnvironment(
		runtime,
		false,
		async () => {
			const path = join(runtime.pristine!.directory, 'ready.json');
			const original = snapshotHash(await readFile(path));

			await withEnvironment(
				runtime,
				false,
				async (api) => {
					expect((await api.database('directus_settings').first()).project_name).toBe('Configured later project');
				},
				signal,
				{ env: { PROJECT_NAME: 'Configured later project' } }
			);

			expect(snapshotHash(await readFile(path))).toBe(original);
		},
		signal
	);
}, 180000);
