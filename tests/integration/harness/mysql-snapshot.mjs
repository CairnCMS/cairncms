import assert from 'node:assert/strict';
import { runSnapshotTool } from './snapshot-tools.mjs';

export const snapshotVendors = Object.freeze(['mysql', 'mysql5', 'maria']);

const definitions = [
	[
		'tables',
		'TABLE_SCHEMA',
		[
			'TABLE_NAME',
			'TABLE_TYPE',
			'ENGINE',
			'ROW_FORMAT',
			'AUTO_INCREMENT',
			'TABLE_COLLATION',
			'CREATE_OPTIONS',
			'TABLE_COMMENT',
		],
	],
	[
		'columns',
		'TABLE_SCHEMA',
		[
			'TABLE_NAME',
			'COLUMN_NAME',
			'ORDINAL_POSITION',
			'COLUMN_DEFAULT',
			'IS_NULLABLE',
			'DATA_TYPE',
			'CHARACTER_MAXIMUM_LENGTH',
			'CHARACTER_OCTET_LENGTH',
			'NUMERIC_PRECISION',
			'NUMERIC_SCALE',
			'DATETIME_PRECISION',
			'CHARACTER_SET_NAME',
			'COLLATION_NAME',
			'COLUMN_TYPE',
			'COLUMN_KEY',
			'EXTRA',
			'COLUMN_COMMENT',
			'GENERATION_EXPRESSION',
		],
	],
	[
		'statistics',
		'TABLE_SCHEMA',
		[
			'TABLE_NAME',
			'NON_UNIQUE',
			'INDEX_NAME',
			'SEQ_IN_INDEX',
			'COLUMN_NAME',
			'COLLATION',
			'SUB_PART',
			'NULLABLE',
			'INDEX_TYPE',
			'INDEX_COMMENT',
			'IS_VISIBLE',
			'EXPRESSION',
		],
	],
	['table_constraints', 'TABLE_SCHEMA', ['TABLE_NAME', 'CONSTRAINT_NAME', 'CONSTRAINT_TYPE', 'ENFORCED']],
	[
		'key_column_usage',
		'TABLE_SCHEMA',
		[
			'TABLE_NAME',
			'CONSTRAINT_NAME',
			'COLUMN_NAME',
			'ORDINAL_POSITION',
			'POSITION_IN_UNIQUE_CONSTRAINT',
			'REFERENCED_TABLE_SCHEMA',
			'REFERENCED_TABLE_NAME',
			'REFERENCED_COLUMN_NAME',
		],
	],
	[
		'referential_constraints',
		'CONSTRAINT_SCHEMA',
		[
			'TABLE_NAME',
			'CONSTRAINT_NAME',
			'UNIQUE_CONSTRAINT_NAME',
			'MATCH_OPTION',
			'UPDATE_RULE',
			'DELETE_RULE',
			'REFERENCED_TABLE_NAME',
		],
	],
	['check_constraints', 'CONSTRAINT_SCHEMA', ['CONSTRAINT_NAME', 'CHECK_CLAUSE']],
	[
		'triggers',
		'TRIGGER_SCHEMA',
		[
			'TRIGGER_NAME',
			'EVENT_MANIPULATION',
			'EVENT_OBJECT_TABLE',
			'ACTION_ORDER',
			'ACTION_CONDITION',
			'ACTION_STATEMENT',
			'ACTION_ORIENTATION',
			'ACTION_TIMING',
			'SQL_MODE',
			'DEFINER',
			'CHARACTER_SET_CLIENT',
			'COLLATION_CONNECTION',
			'DATABASE_COLLATION',
		],
	],
	[
		'routines',
		'ROUTINE_SCHEMA',
		[
			'ROUTINE_NAME',
			'ROUTINE_TYPE',
			'DATA_TYPE',
			'ROUTINE_DEFINITION',
			'IS_DETERMINISTIC',
			'SQL_DATA_ACCESS',
			'SECURITY_TYPE',
			'SQL_MODE',
			'DEFINER',
		],
	],
	[
		'events',
		'EVENT_SCHEMA',
		[
			'EVENT_NAME',
			'EVENT_DEFINITION',
			'EVENT_TYPE',
			'EXECUTE_AT',
			'INTERVAL_VALUE',
			'INTERVAL_FIELD',
			'STATUS',
			'ON_COMPLETION',
			'SQL_MODE',
			'DEFINER',
		],
	],
];

/** @param {import('knex').Knex} database */
export async function snapshotInventory(
	database,
	name,
	signal,
	{ vendor = 'mysql', deadline = performance.now() + 90_000 } = {}
) {
	assert(snapshotVendors.includes(vendor), 'Unsupported snapshot vendor');

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
	// MySQL caches these statistics; restoration checks require the current auto-increment values.
	if (vendor === 'mysql') await query(database.raw('SET SESSION information_schema_stats_expiry=0'));

	for (const [table, scope, original] of definitions) {
		// MySQL 5.7 has no enforced checks; the pinned engines expose different index metadata.
		if (vendor === 'mysql5' && table === 'check_constraints') continue;
		let fields = original;

		if (vendor !== 'mysql' && table === 'statistics') {
			fields = fields.filter((field) => !['IS_VISIBLE', 'EXPRESSION'].includes(field));
			if (vendor === 'maria') fields = [...fields, 'IGNORED'];
		}

		if (vendor !== 'mysql' && table === 'table_constraints') fields = fields.filter((field) => field !== 'ENFORCED');
		if (vendor === 'maria' && table === 'check_constraints') fields = [...fields, 'TABLE_NAME', 'LEVEL'];

		const rows = await query(
			database(`information_schema.${table}`)
				.select(fields)
				.where({ [scope]: name })
		);

		for (const row of rows) if (row.REFERENCED_TABLE_SCHEMA === name) row.REFERENCED_TABLE_SCHEMA = '<database>';
		result.schema[table] = sort(rows);
	}

	for (const { TABLE_NAME } of result.schema.tables)
		result.rows[TABLE_NAME] = sort(await query(database(TABLE_NAME).select('*')));
	return result;
}

export async function snapshotCommand({
	vendor = 'mysql',
	container,
	database,
	password,
	operation,
	input,
	signal,
	record,
}) {
	assert(snapshotVendors.includes(vendor), 'Unsupported snapshot vendor');
	signal.throwIfAborted();

	const command =
		operation === 'export'
			? [
					vendor === 'maria' ? 'mariadb-dump' : 'mysqldump',
					'--user=root',
					'--single-transaction',
					...(vendor === 'maria' ? [] : ['--set-gtid-purged=OFF']),
					'--no-tablespaces',
					'--skip-comments',
					'--skip-dump-date',
					'--routines',
					'--events',
					'--triggers',
					'--hex-blob',
					'--default-character-set=utf8mb4',
					database,
			  ]
			: [vendor === 'maria' ? 'mariadb' : 'mysql', '--user=root', '--default-character-set=utf8mb4', database];

	return runSnapshotTool({
		args: ['exec', ...(operation === 'import' ? ['-i'] : []), '--env', `MYSQL_PWD=${password}`, container, ...command],
		operation,
		input,
		signal,
		record,
	});
}
