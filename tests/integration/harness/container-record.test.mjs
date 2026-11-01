import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeContainerRecord } from './container-record.mjs';
import { owners } from './control-process.mjs';
import { RecordedContainer } from './recorded-container.mjs';

const starting = { serviceKey: 'fixture', state: 'starting' };

for (const [mode, previous, expected] of [
	['creation', undefined, starting],
	['container-id', starting, { ...starting, id: 'container-id' }],
	['removal', starting, { serviceKey: 'fixture', removed: true }],
]) {
	test(`readers see only complete records during ${mode}`, { timeout: 5000 }, async (t) => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'cairn-container-record-'));
		const path = join(directory, 'fixture.service.json');
		const paused = Promise.withResolvers();
		const resume = Promise.withResolvers();
		let writing;

		try {
			if (previous) await fs.writeFile(path, JSON.stringify(previous));

			t.mock.method(fs, 'writeFile', async (target, contents) => {
				const file = await fs.open(target, 'w');

				try {
					await file.write(contents.slice(0, 2));
					paused.resolve();
					await resume.promise;
					await file.writeFile(contents.slice(2));
				} finally {
					await file.close();
				}
			});

			syncBuiltinESMExports();

			writing =
				mode === 'container-id'
					? new RecordedContainer('fixture-image', path).containerCreated('container-id')
					: writeContainerRecord(path, expected);

			await Promise.race([paused.promise, writing.then(() => assert.fail('Write did not pause'))]);
			assert.deepEqual(await owners(directory, '.service.json'), previous ? [previous] : []);
			resume.resolve();
			await writing;
			assert.deepEqual(await owners(directory, '.service.json'), [expected]);
			assert.deepEqual(await fs.readdir(directory), ['fixture.service.json']);
		} finally {
			resume.resolve();
			await writing?.catch(() => {});
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}

test('a failed record write preserves the published record and removes its partial file', async (t) => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'cairn-container-record-'));
	const path = join(directory, 'fixture.service.json');
	const writeFile = fs.writeFile;
	const failure = new Error('Write interrupted');

	try {
		await writeFile(path, JSON.stringify(starting));

		t.mock.method(fs, 'writeFile', async (target) => {
			await writeFile(target, '{');
			throw failure;
		});

		syncBuiltinESMExports();
		await assert.rejects(writeContainerRecord(path, { ...starting, removed: true }), (error) => error === failure);
		assert.deepEqual(await owners(directory, '.service.json'), [starting]);
		assert.deepEqual(await fs.readdir(directory), ['fixture.service.json']);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
