import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_EMAIL, ADMIN_PASSWORD, COLLECTIONS, ENV_KEYS } from './helpers/constants.js';
import { buildApiEnv } from './helpers/api-env.js';
import { seedFixtureData } from './helpers/seed.js';
import { applySchemaFixture, grantPublicRead, login } from './helpers/setup-http.js';
import { type ApiHandle, pickUnusedPort, runBootstrap, spawnApi, waitForReady } from './helpers/spawn-api.js';
import { cleanupTempDir, createTempDir } from './helpers/temp-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

let apiHandle: ApiHandle | null = null;
let tempDir: string | null = null;

export async function setup(): Promise<void> {
	try {
		tempDir = await createTempDir();

		const port = await pickUnusedPort();
		const url = `http://localhost:${port}`;
		const env = buildApiEnv({ tempDir, port });

		// Step 1: bootstrap the fresh SQLite DB (migrations + admin user creation)
		await runBootstrap(env, REPO_ROOT);

		// Step 2: spawn the API subprocess and wait for readiness
		apiHandle = spawnApi(env, REPO_ROOT);
		await waitForReady(url);

		// Step 3: admin login (setup-only token, discarded after fixture application)
		const token = await login(url, ADMIN_EMAIL, ADMIN_PASSWORD);

		// Step 4: create the three fixture collections via raw HTTP
		await applySchemaFixture(url, token);

		// Step 5: grant public read access on the public-readable collection
		await grantPublicRead(url, token, COLLECTIONS.publicItems);

		// Step 6: seed rows directly via knex (bypasses SDK-under-test)
		const dbPath = env['DB_FILENAME']!;
		await seedFixtureData(dbPath);

		// Publish connection info to tests via env vars
		process.env[ENV_KEYS.url] = url;
		process.env[ENV_KEYS.adminEmail] = ADMIN_EMAIL;
		process.env[ENV_KEYS.adminPassword] = ADMIN_PASSWORD;
		process.env[ENV_KEYS.tempDir] = tempDir;
	} catch (err) {
		// Clean up on failure: otherwise the API subprocess leaks and the next
		// run will fail for confusing reasons (port conflicts, zombie DBs, etc.).
		await teardown();
		throw err;
	}
}

export async function teardown(): Promise<void> {
	if (apiHandle) {
		await apiHandle.kill();
		apiHandle = null;
	}

	if (tempDir) {
		await cleanupTempDir(tempDir);
		tempDir = null;
	}
}
