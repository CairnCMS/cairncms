import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeOwnedDirectories } from './exit-cleanup.mjs';

for (const mode of [
	'owned',
	'different-report',
	'different-id',
	'empty-unmarked',
	'nonempty-unmarked',
	'outside-prefix',
	'symlink',
]) {
	test(`directory cleanup respects ownership: ${mode}`, async (context) => {
		const reports = await mkdtemp(join(tmpdir(), 'cleanup-reports-'));
		const directory = await mkdtemp(join(tmpdir(), mode === 'outside-prefix' ? 'unrelated-' : 'cairn-integration-'));
		const link = join(tmpdir(), `cairn-integration-${randomUUID()}`);

		context.after(async () => {
			await rm(link, { force: true });
			await rm(directory, { recursive: true, force: true });
			await rm(reports, { recursive: true, force: true });
		});

		const id = `test_${randomUUID().replaceAll('-', '')}`;
		if (mode === 'symlink') await symlink(directory, link);

		await writeFile(
			join(reports, `${id}.owner.json`),
			JSON.stringify({ directory: mode === 'symlink' ? link : directory, database: id })
		);

		if (mode === 'nonempty-unmarked') await writeFile(join(directory, 'retain.txt'), 'retain');
		if (!mode.includes('unmarked'))
			await writeFile(
				join(directory, '.integration-owner.json'),
				JSON.stringify({
					id: mode === 'different-id' ? 'another' : id,
					reports: mode === 'different-report' ? '/elsewhere' : reports,
				})
			);
		const result = await removeOwnedDirectories(reports);

		if (['owned', 'empty-unmarked'].includes(mode)) {
			assert.deepEqual(result, { removed: [directory], errors: [] });
			await assert.rejects(access(directory), { code: 'ENOENT' });
			assert.deepEqual(await removeOwnedDirectories(reports), { removed: [], errors: [] });
		} else {
			assert.equal(result.errors.length, 1);
			assert.deepEqual(result.removed, []);
			await access(directory);
			if (mode === 'nonempty-unmarked') assert.equal(await readFile(join(directory, 'retain.txt'), 'utf8'), 'retain');
		}
	});
}
