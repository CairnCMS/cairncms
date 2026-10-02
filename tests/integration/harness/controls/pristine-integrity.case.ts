import { test, expect, inject } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withEnvironment } from '../../fixtures/environment';
import { snapshotHash } from '../snapshot.mjs';
import { initializeFixtures } from '../fixture-setup.mjs';
import { ensureTemplate } from './pristine-support';

initializeFixtures();

test('pristine initialization verifies immutable state before independent API use', async ({ signal }) => {
	const runtime = inject('integration');
	const directory = runtime.pristine!.directory;

	await withEnvironment(
		runtime,
		false,
		async (source) => {
			const metadata = await readFile(join(directory, 'ready.json'));
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, 'pristine.snapshot'))).mode & 0o777).toBe(0o600);

			await withEnvironment(
				runtime,
				false,
				async (copy) => {
					expect(copy.adminToken).toBeTypeOf('string');
					expect(copy.url).not.toBe(source.url);
				},
				signal
			);

			expect(snapshotHash(await readFile(join(directory, 'ready.json')))).toBe(snapshotHash(metadata));
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
	['partial-restore', 'Restored database differs'],
	['invalid-sql', 'INVALID_RESTORE_SQL'],
	['wrong-collation', 'Restored database differs'],
]) {
	test(`rejects ${fault} before exposing an API`, async ({ signal }) => {
		const runtime = inject('integration');
		const directory = runtime.pristine!.directory;
		await ensureTemplate(runtime, signal);
		const dump = await readFile(join(directory, 'pristine.snapshot'));
		const original = await readFile(join(directory, 'ready.json'));
		const metadata = JSON.parse(original.toString());
		let entered = false;

		try {
			if (fault === 'malformed-hash') metadata.dumpHash = 'invalid-template-value';
			if (fault === 'mixed-build') metadata.buildHash = '0'.repeat(64);
			if (fault === 'corrupt-inventory') metadata.snapshotHash = '0'.repeat(64);
			if (fault === 'corrupt-dump')
				await writeFile(join(directory, 'pristine.snapshot'), Buffer.concat([dump, Buffer.from('\n-- changed\n')]));

			if (['partial-restore', 'wrong-collation', 'invalid-sql'].includes(fault)) {
				let bytes: Buffer;
				if (fault === 'partial-restore') bytes = Buffer.from('CREATE TABLE incomplete_restore (id int PRIMARY KEY);');
				else if (fault === 'invalid-sql') bytes = Buffer.from('INVALID_RESTORE_SQL;');
				else
					bytes = Buffer.concat([
						dump,
						Buffer.from(
							'\nALTER TABLE directus_users MODIFY first_name varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;'
						),
					]);

				await writeFile(join(directory, 'pristine.snapshot'), bytes);
				metadata.dumpHash = snapshotHash(bytes);
			}

			await writeFile(
				join(directory, 'ready.json'),
				fault === 'malformed-metadata' ? 'invalid-template-value invalid json' : JSON.stringify(metadata)
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
			await writeFile(join(directory, 'pristine.snapshot'), dump);
			await writeFile(join(directory, 'ready.json'), original);
		}
	}, 120000);
}
