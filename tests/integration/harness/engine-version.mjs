import { runSnapshotTool } from './snapshot-tools.mjs';

/** Returns the client command that prints the engine version inside a vendor's container. */
export function engineCommand(definition) {
	const query = 'select version()';

	switch (definition.family) {
		case 'postgres':
			return [
				'psql',
				'--host=127.0.0.1',
				`--username=${definition.user}`,
				`--dbname=${definition.database}`,
				'--tuples-only',
				'--no-align',
				`--command=${query}`,
			];
		case 'mysql':
		case 'maria':
			return [
				definition.family === 'maria' ? 'mariadb' : 'mysql',
				'--host=127.0.0.1',
				`--user=${definition.user}`,
				`--password=${definition.environment.MYSQL_ROOT_PASSWORD}`,
				'--silent',
				'--skip-column-names',
				`--execute=${query}`,
			];
		default:
			throw new Error(`No engine command for the ${definition.family} family`);
	}
}

/** Combines a run's cancellation with the probe deadline. */
export const probeSignal = (cancellation, deadline = 30_000) =>
	AbortSignal.any([cancellation, AbortSignal.timeout(deadline)]);

/**
 * Reads the engine version from a running container. Only stdout is evidence: the
 * MySQL client warns about the password on stderr even when the query succeeds.
 */
export async function recordEngine({
	id,
	definition,
	command = engineCommand(definition),
	signal,
	record,
	stderr = () => {},
}) {
	let output;

	try {
		output = await runSnapshotTool({
			args: ['exec', id, ...command],
			operation: 'engine-version',
			signal,
			record,
			stderr,
		});
	} catch (error) {
		let outcome = 'failed';
		if (signal.aborted) outcome = signal.reason?.name === 'TimeoutError' ? 'exceeded its deadline' : 'was cancelled';
		throw new Error(`Engine version probe ${outcome}: ${error.message}`, { cause: error });
	}

	const engine = output.toString().trim().split('\n')[0].trim();
	if (!engine) throw new Error('Engine version probe returned no version');
	return engine;
}

/** Reads the SQLite version bundled with the Node.js runtime the API runs on. */
export async function sqliteEngine() {
	const { DatabaseSync } = await import('node:sqlite');
	const database = new DatabaseSync(':memory:');

	try {
		return database.prepare('select sqlite_version() as version').get().version;
	} finally {
		database.close();
	}
}
