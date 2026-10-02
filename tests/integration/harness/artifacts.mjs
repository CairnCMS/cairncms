import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const required = [
	'api/dist/server.js',
	'api/dist/cli/run.js',
	'api/dist/extensions/confined/runtime/child-host.mjs',
	'api/dist/extensions/confined/runtime/emscripten-module.wasm',
	'sdk/dist/index.js',
];

export async function compiledArtifacts(root) {
	const hashes = {};

	for (const file of required) {
		let contents;

		try {
			contents = await readFile(join(root, file));
		} catch (error) {
			throw new Error(
				`Required compiled artifact ${file} is unavailable (${error.code}). Run pnpm test:integration:prepare, then retry.`
			);
		}

		if (!contents.length)
			throw new Error(`Required compiled artifact ${file} is empty. Run pnpm test:integration:prepare, then retry.`);
		hashes[file] = createHash('sha256').update(contents).digest('hex');
	}

	const visit = async (directory) => {
		const entries = await readdir(join(root, directory), { withFileTypes: true });

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const file = `${directory}/${entry.name}`;
			if (entry.isDirectory()) await visit(file);
			else if (entry.isFile() && !hashes[file])
				hashes[file] = createHash('sha256')
					.update(await readFile(join(root, file)))
					.digest('hex');
		}
	};

	await visit('api/dist');
	await visit('sdk/dist');

	return hashes;
}
