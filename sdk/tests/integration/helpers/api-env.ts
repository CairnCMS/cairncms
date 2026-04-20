import { join } from 'node:path';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './constants.js';

/**
 * Hermetic environment for the integration-test API subprocess.
 * Deliberately ignores api/.env — the harness builds its own env from scratch
 * so integration runs don't pollute or depend on local dev state.
 */
export function buildApiEnv(options: { tempDir: string; port: number }): NodeJS.ProcessEnv {
	const dbPath = join(options.tempDir, 'directus.db');

	return {
		...process.env,

		// Directus's env loader reads the .env file at CONFIG_PATH (defaults to
		// cwd + '.env') AFTER process.env, so any .env at the repo root would
		// override our explicit overrides. Point CONFIG_PATH at a non-existent
		// file so Directus falls back to process.env only.
		CONFIG_PATH: join(options.tempDir, '.no-env-file'),

		NODE_ENV: 'test',
		LOG_LEVEL: 'error',

		DB_CLIENT: 'sqlite3',
		DB_FILENAME: dbPath,

		PORT: String(options.port),
		PUBLIC_URL: `http://localhost:${options.port}`,

		KEY: 'sdk-integration-key',
		SECRET: 'sdk-integration-secret',

		ADMIN_EMAIL,
		ADMIN_PASSWORD,

		SERVE_APP: 'false',

		// Reduce surface area: no background jobs, no caching, no mail
		CACHE_ENABLED: 'false',
		RATE_LIMITER_ENABLED: 'false',
		EMAIL_TRANSPORT: 'sendmail',
		TELEMETRY: 'false',
	};
}
