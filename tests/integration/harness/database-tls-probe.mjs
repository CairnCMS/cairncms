import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../api/package.json', import.meta.url));
const knexRequire = createRequire(require.resolve('knex'));

const versions = Object.fromEntries(
	['pg', 'mysql2', 'knex'].map((name) => [name, require(`${name}/package.json`).version])
);

versions.pgConnectionString = knexRequire('pg-connection-string/package.json').version;
const { default: getDatabase, getDatabaseClient } = await import('../../../api/dist/database/index.js');
const database = getDatabase();
let result;

try {
	const postgres = getDatabaseClient(database) === 'postgres';
	const query = await database.raw('SELECT 42 AS tls_probe');
	const rows = postgres ? query.rows : query[0];

	const transport = postgres
		? (await database.raw('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0].ssl
		: (await database.raw("SHOW SESSION STATUS LIKE 'Ssl_cipher'"))[0][0].Value !== '';

	result = { ok: true, value: rows[0].tls_probe, encrypted: transport, versions };
} catch (error) {
	result = { ok: false, error: { code: error.code, message: error.message }, versions };
} finally {
	await database.destroy();
}

// Database initialization starts background work. This one-shot child owns its lifetime after pool cleanup.
process.stdout.write(`DATABASE_TLS_RESULT ${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
