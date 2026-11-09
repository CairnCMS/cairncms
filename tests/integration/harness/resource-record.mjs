import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

// Cleanup probes read these records while processes and containers start and stop.
export async function writeResourceRecord(path, record) {
	const pending = `${path}.${randomUUID()}.partial`;

	try {
		await writeFile(pending, JSON.stringify(record) + '\n');
		await rename(pending, path);
	} finally {
		await rm(pending, { force: true });
	}
}
