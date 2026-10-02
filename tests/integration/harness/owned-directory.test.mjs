import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeMarkedDirectory } from './owned-directory.mjs';
import { removeOwnedDirectories } from './exit-cleanup.mjs';
import { createPristineStore, removePristineStore } from './pristine.mjs';

for (const kind of ['fixture', 'pristine'])
	test(`interrupted ${kind} removal preserves ownership for fallback cleanup`, async (context) => {
		const reports = await mkdtemp(join(tmpdir(), 'cleanup-reports-'));

		const directory =
			kind === 'fixture'
				? await mkdtemp(join(tmpdir(), 'cairn-integration-'))
				: (await createPristineStore(reports, { build: 'one' })).directory;

		const data = join(directory, 'data');

		context.after(async () => {
			await chmod(data, 0o700).catch((error) => {
				if (error.code !== 'ENOENT') throw error;
			});

			await rm(directory, { recursive: true, force: true });
			await rm(reports, { recursive: true, force: true });
		});

		if (kind === 'fixture') {
			const id = `test_${randomUUID().replaceAll('-', '')}`;
			await writeFile(join(reports, `${id}.owner.json`), JSON.stringify({ directory, database: id }));
			await writeFile(join(directory, '.integration-owner.json'), JSON.stringify({ id, reports }));
		}

		const marker = await readFile(join(directory, '.integration-owner.json'), 'utf8');
		await mkdir(data);
		await writeFile(join(data, 'retain.txt'), 'pending cleanup');
		await chmod(data, 0o500);

		await assert.rejects(kind === 'fixture' ? removeMarkedDirectory(directory) : removePristineStore(reports), {
			code: 'EACCES',
		});

		assert.equal(await readFile(join(directory, '.integration-owner.json'), 'utf8'), marker);
		assert.equal(await readFile(join(data, 'retain.txt'), 'utf8'), 'pending cleanup');
		await chmod(data, 0o700);

		if (kind === 'fixture') {
			assert.deepEqual(await removeOwnedDirectories(reports), { removed: [directory], errors: [] });
		} else await removePristineStore(reports);

		await assert.rejects(access(directory), { code: 'ENOENT' });
	});
