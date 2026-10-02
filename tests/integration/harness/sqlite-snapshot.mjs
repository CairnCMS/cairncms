import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';

export async function snapshotCommand({ filename, operation, input, signal }) {
	signal.throwIfAborted();

	// Bootstrap has exited and the fixture pool has not opened. Copying an active
	// journal/WAL would not produce a standalone database, so reject that state.
	for (const suffix of ['-wal', '-shm', '-journal']) {
		const present = await access(filename + suffix).then(
			() => true,
			(error) => {
				if (error.code === 'ENOENT') return false;
				throw error;
			}
		);

		assert(!present, `SQLite snapshot has an active sidecar: ${suffix}`);
	}

	if (operation === 'export') return readFile(filename, { signal });
	await writeFile(filename, input, { mode: 0o600, signal });
	signal.throwIfAborted();
}

/** @param {import('knex').Knex} database */
export async function snapshotInventory(database, _name, signal, { deadline = performance.now() + 90_000 } = {}) {
	const query = async (builder) => {
		signal?.throwIfAborted();
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error('Database initialization exceeded 90000ms');
		const value = await builder.timeout(Math.min(10_000, Math.ceil(remaining)));
		signal?.throwIfAborted();
		return value;
	};

	const sort = (rows) =>
		JSON.parse(JSON.stringify(rows)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

	/** @type {{schema: Record<string, Record<string, unknown>[]>, rows: Record<string, Record<string, unknown>[]>}} */
	const result = { schema: {}, rows: {} };
	result.schema.objects = sort(await query(database('sqlite_master').select('type', 'name', 'tbl_name', 'sql')));
	for (const setting of ['encoding', 'user_version', 'application_id', 'foreign_keys'])
		result.schema[setting] = await query(database.raw(`PRAGMA ${setting}`));

	for (const table of result.schema.objects.filter((object) => object.type === 'table')) {
		result.rows[table.name] = sort(await query(database(table.name).select('*')));
		result.schema[`columns:${table.name}`] = sort(await query(database.raw('PRAGMA table_xinfo(??)', [table.name])));

		result.schema[`foreign-keys:${table.name}`] = sort(
			await query(database.raw('PRAGMA foreign_key_list(??)', [table.name]))
		);
	}

	return result;
}
