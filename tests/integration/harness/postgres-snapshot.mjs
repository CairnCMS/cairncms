import assert from 'node:assert/strict';
import { runSnapshotTool } from './snapshot-tools.mjs';

export async function snapshotCommand({ container, database, template, password, operation, input, signal, record }) {
	assert(/^test_[a-f0-9]{32}$/.test(database), 'Invalid snapshot database');
	assert(/^test_template_[a-f0-9]{32}$/.test(template), 'Invalid snapshot template');
	if (operation === 'import')
		assert.equal(JSON.parse(input.toString()).template, template, 'Pristine template mismatch');

	// No fixture connection is opened until capture/restore completes. The template
	// rejects connections so later files cannot mutate it or obstruct cloning.
	const statements =
		operation === 'export'
			? [`CREATE DATABASE "${template}" TEMPLATE "${database}" ALLOW_CONNECTIONS false`]
			: [`CREATE DATABASE "${database}" TEMPLATE "${template}"`];

	await runSnapshotTool({
		args: [
			'exec',
			'--env',
			`PGPASSWORD=${password}`,
			container,
			'psql',
			'-X',
			'-v',
			'ON_ERROR_STOP=1',
			'-U',
			'integration',
			'-d',
			'postgres',
			...statements.flatMap((sql) => ['-c', sql]),
		],
		operation,
		signal,
		record,
	});

	return Buffer.from(JSON.stringify({ template }));
}

/** @param {import('knex').Knex} database */
export async function snapshotInventory(
	database,
	_name,
	signal,
	{ vendor = 'postgres', deadline = performance.now() + 90_000 } = {}
) {
	const query = async (builder) => {
		signal?.throwIfAborted();
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error('Database initialization exceeded 90000ms');
		const result = await builder.timeout(Math.min(10_000, Math.ceil(remaining)));
		signal?.throwIfAborted();
		return result;
	};

	const sort = (rows) =>
		JSON.parse(JSON.stringify(rows)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

	/** @type {{schema: Record<string, Record<string, unknown>[]>, rows: Record<string, Record<string, unknown>[]>}} */
	const result = { schema: {}, rows: {} };
	const scope = "n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'";

	const definitions = {
		database: `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype, datconnlimit, datacl
			FROM pg_database WHERE datname = current_database()`,
		settings: `SELECT setrole::regrole::text AS role, setconfig FROM pg_db_role_setting
			WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`,
		schemas: `SELECT nspname, nspowner::regrole::text AS owner, nspacl FROM pg_namespace n WHERE ${scope}`,
		extensions: `SELECT extname, extversion, n.nspname FROM pg_extension JOIN pg_namespace n ON n.oid = extnamespace`,
		tables: `SELECT n.nspname, c.relname, c.relkind, c.relowner::regrole::text AS owner,
			c.relacl, c.reloptions, c.relrowsecurity, c.relforcerowsecurity, obj_description(c.oid, 'pg_class') AS comment
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${scope} AND c.relkind IN ('r','p','v','m','S')`,
		columns: `SELECT n.nspname, c.relname, a.attname, a.attnum, format_type(a.atttypid,a.atttypmod) AS type,
			a.attnotnull, a.attidentity, a.attstorage, a.attacl, a.attoptions, co.collname, cn.nspname AS collation_schema,
			pg_get_expr(d.adbin,d.adrelid) AS default_value, col_description(c.oid,a.attnum) AS comment
			FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
			LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
			LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
			WHERE ${scope} AND a.attnum > 0 AND NOT a.attisdropped`,
		constraints: `SELECT n.nspname, c.relname, con.conname, con.contype, con.condeferrable, con.condeferred,
			con.convalidated, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
			JOIN pg_namespace n ON n.oid=con.connamespace LEFT JOIN pg_class c ON c.oid=con.conrelid WHERE ${scope}`,
		indexes: `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
			WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'`,
		triggers: `SELECT n.nspname, c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
			FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE ${scope} AND NOT t.tgisinternal`,
		views: `SELECT schemaname, viewname, definition FROM pg_views
			WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'`,
		policies: `SELECT * FROM pg_policies WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'`,
		functions: `SELECT n.nspname, p.proname, pg_get_functiondef(p.oid) AS definition,
            p.proowner::regrole::text AS owner, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE ${scope} AND ${vendor === 'postgres10' ? 'NOT p.proisagg' : "p.prokind <> 'a'"}
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`,
		enums: `SELECT n.nspname, t.typname, e.enumsortorder, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
            JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${scope}`,
		sequences: `SELECT schemaname, sequencename, sequenceowner, data_type::text, start_value,
			min_value, max_value, increment_by, cycle, cache_size FROM pg_sequences
			WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'`,
	};

	for (const [key, sql] of Object.entries(definitions))
		result.schema[key] = sort((await query(database.raw(sql))).rows);

	for (const table of result.schema.tables) {
		const name = table.nspname === 'public' ? table.relname : `${table.nspname}.${table.relname}`;

		if (table.relkind === 'S') {
			result.rows[name] = sort(
				await query(database.withSchema(table.nspname).from(table.relname).select('last_value', 'is_called'))
			);
		} else if (['r', 'p', 'm'].includes(table.relkind)) {
			// Hash the large PostGIS reference table in the engine; retain complete
			// Directus rows for the fresh-bootstrap equivalence controls.
			result.rows[name] =
				table.relname === 'spatial_ref_sys'
					? (
							await query(
								database.raw(
									"SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY srid)) AS contents FROM ??.?? t",
									[table.nspname, table.relname]
								)
							)
					  ).rows
					: sort(await query(database.withSchema(table.nspname).from(table.relname).select('*')));
		}
	}

	return result;
}
