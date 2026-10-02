import { promisify } from 'util';
import logger from '../logger.js';

type AfterCreateCallback = (error: unknown, connection?: unknown) => void;

export function sqliteAfterCreate(conn: any, callback: AfterCreateCallback): void {
	logger.trace('Enabling SQLite Foreign Keys support...');
	const run = promisify(conn.run.bind(conn));

	run('PRAGMA foreign_keys = ON')
		.then(() => run('PRAGMA busy_timeout = 5000'))
		.then(
			() => callback(null, conn),
			(error: unknown) => callback(error)
		);
}

export function cockroachAfterCreate(conn: any, callback: AfterCreateCallback): void {
	logger.trace('Setting CRDB serial_normalization and default_int_size');
	const run = promisify(conn.query.bind(conn));

	run('SET serial_normalization = "sql_sequence"')
		.then(() => run('SET default_int_size = 4'))
		.then(
			() => callback(null, conn),
			(error: unknown) => callback(error)
		);
}

export function createMysqlAfterCreate(onVersion: (version: string) => void) {
	return function mysqlAfterCreate(conn: any, callback: AfterCreateCallback): void {
		logger.trace('Retrieving database version');
		const run = promisify(conn.query.bind(conn));

		run('SELECT @@version;')
			.then((rows: any) => {
				onVersion(rows[0]['@@version']);
			})
			.then(
				() => callback(null, conn),
				(error: unknown) => callback(error)
			);
	};
}
