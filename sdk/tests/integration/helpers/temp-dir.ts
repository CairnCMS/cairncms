import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a unique temp directory for a single integration-test run.
 * Returns its absolute path. Caller is responsible for teardown via cleanup().
 */
export async function createTempDir(): Promise<string> {
	const dir = join(tmpdir(), `cairncms-sdk-integration-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
