import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function removeMarkedDirectory(directory) {
	const entries = await readdir(directory).catch((error) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});

	// Keep ownership recoverable if cleanup is interrupted while data still exists.
	for (const entry of entries) {
		if (entry !== '.integration-owner.json') await rm(join(directory, entry), { recursive: true, force: true });
	}

	await rm(join(directory, '.integration-owner.json'), { force: true });

	await rmdir(directory).catch((error) => {
		if (error.code !== 'ENOENT') throw error;
	});
}
