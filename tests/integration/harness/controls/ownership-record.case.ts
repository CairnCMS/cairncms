import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { expect, inject, test, vi } from 'vitest';
import { withEnvironment } from '../../fixtures/environment';
import { owners } from '../control-process.mjs';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('environment ownership records stay complete while processes start', async () => {
	const runtime = inject('integration');
	const writeFile = fs.writeFile;
	const childCounts: number[] = [];
	let expectedChildren: number[];

	const writer = vi.spyOn(fs, 'writeFile').mockImplementation(async (target, contents, options) => {
		const path = String(target);
		if (dirname(path) !== runtime.directory || !path.includes('.owner.json') || typeof contents !== 'string')
			return writeFile(target, contents, options);

		const published = await owners(runtime.directory);
		const file = await fs.open(path, 'w');

		try {
			// Force a reader into the partial-write window without relying on scheduler timing.
			await file.write(contents.slice(0, 2));
			expect(await owners(runtime.directory)).toEqual(published);
		} finally {
			try {
				await file.writeFile(contents.slice(2));
			} finally {
				await file.close();
			}
		}

		childCounts.push(JSON.parse(contents).children?.length ?? 0);
	});

	syncBuiltinESMExports();

	try {
		await withEnvironment(runtime, false, async (api) => {
			const companion = await api.start({});
			expectedChildren = [api.child.pid!, companion.child.pid!];
		});

		expect(childCounts).toEqual([0, 1, 2, 3]);
		const records = await owners(runtime.directory);
		expect(records).toHaveLength(1);
		expect(records[0].children.slice(1)).toEqual(expectedChildren!);
	} finally {
		writer.mockRestore();
		syncBuiltinESMExports();
	}
});
