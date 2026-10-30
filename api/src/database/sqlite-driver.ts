import type { Knex } from 'knex';
import { createRequire } from 'node:module';
import type {
	DatabaseSync,
	SQLInputValue,
	SQLOutputValue,
	StatementResultingChanges,
	StatementSync,
} from 'node:sqlite';

const require = createRequire(import.meta.url);

const OPEN_READONLY = 0x00000001;
const OPEN_READWRITE = 0x00000002;
const OPEN_CREATE = 0x00000004;
const OPEN_URI = 0x00000040;
const OPEN_FULLMUTEX = 0x00010000;
const OPEN_SHAREDCACHE = 0x00020000;
const OPEN_PRIVATECACHE = 0x00040000;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const DEFAULT_BUSY_TIMEOUT_MS = 1000;

const RESULT_CODES = [
	'SQLITE_OK',
	'SQLITE_ERROR',
	'SQLITE_INTERNAL',
	'SQLITE_PERM',
	'SQLITE_ABORT',
	'SQLITE_BUSY',
	'SQLITE_LOCKED',
	'SQLITE_NOMEM',
	'SQLITE_READONLY',
	'SQLITE_INTERRUPT',
	'SQLITE_IOERR',
	'SQLITE_CORRUPT',
	'SQLITE_NOTFOUND',
	'SQLITE_FULL',
	'SQLITE_CANTOPEN',
	'SQLITE_PROTOCOL',
	'SQLITE_EMPTY',
	'SQLITE_SCHEMA',
	'SQLITE_TOOBIG',
	'SQLITE_CONSTRAINT',
	'SQLITE_MISMATCH',
	'SQLITE_MISUSE',
	'SQLITE_NOLFS',
	'SQLITE_AUTH',
	'SQLITE_FORMAT',
	'SQLITE_RANGE',
	'SQLITE_NOTADB',
	'SQLITE_NOTICE',
	'SQLITE_WARNING',
];

type Callback = (this: unknown, error: Error | null, result?: unknown) => void;

type Bindings = { positional: SQLInputValue[]; named?: Record<string, SQLInputValue> };

type StatementContext = { sql: string; lastID: number; changes: number };

function sqliteError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { errno: RESULT_CODES.indexOf(code), code });
}

function toSqliteError(error: unknown): Error {
	const errcode = (error as { errcode?: unknown } | null)?.errcode;
	if (!(error instanceof Error) || typeof errcode !== 'number') return error as Error;
	return sqliteError(RESULT_CODES[errcode & 0xff] ?? 'SQLITE_ERROR', error.message);
}

/**
 * SQLite accepts only a read-only open, a read-write open, or a read-write open that may create
 * the file. Any other combination is rejected the way sqlite3_open_v2 rejects it.
 */
function isValidOpenMode(mode: number): boolean {
	return ((1 << (mode & 7)) & 0x46) !== 0;
}

function resolveFilename(filename: string, mode: number): string {
	if ((mode & OPEN_URI) === 0 && filename.startsWith('file:')) return `./${filename}`;
	return filename;
}

/**
 * Earlier releases open a file: name as a literal path, so a URI would open or create a different
 * database from the configured one.
 */
export function supportsUriFilenames(nodeVersion: string): boolean {
	const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
	if (major === 22) return minor >= 15;
	if (major === 23) return minor >= 10;
	return major > 23;
}

function loadNodeSqlite(): { DatabaseSync: typeof DatabaseSync } {
	try {
		return require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
	} catch (error) {
		throw new Error(
			'SQLite requires the node:sqlite module, available in Node.js 22.13.0 or later, or 22.5.0 or later started with --experimental-sqlite. Update Node.js to a current 22 or 24 release.',
			{ cause: error }
		);
	}
}

/**
 * Values bind the way the previous driver bound them, so existing files keep matching. Integers
 * within the signed 32-bit range bind as INTEGER and every other number as REAL. A bigint, symbol,
 * NaN, or invalid Date binds as NULL, a RegExp binds as its source text, and any other object
 * except a Date or binary view binds as the text '[object Object]'.
 */
function bindValue(value: unknown): SQLInputValue {
	if (value === undefined || value === null || typeof value === 'bigint' || typeof value === 'symbol') return null;
	if (typeof value === 'boolean') return value ? 1n : 0n;

	if (typeof value === 'number') {
		if (Number.isNaN(value)) return null;
		return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX ? BigInt(value) : value;
	}

	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isNaN(time) ? null : time;
	}

	if (typeof value === 'string') return value;
	if (value instanceof RegExp) return String(value);
	if (ArrayBuffer.isView(value)) return value as SQLInputValue;
	if (typeof value === 'object' || typeof value === 'function') return '[object Object]';
	return String(value);
}

function isNamedParameters(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	return !ArrayBuffer.isView(value) && !(value instanceof Date) && !(value instanceof RegExp);
}

function bindParameters(params: unknown[]): Bindings {
	if (params.length === 1) {
		const [only] = params;

		if (only === undefined || only === null) return { positional: [] };
		if (Array.isArray(only)) return { positional: only.map(bindValue) };

		if (isNamedParameters(only)) {
			const named: Record<string, SQLInputValue> = {};
			for (const [key, value] of Object.entries(only)) named[key] = bindValue(value);
			return { positional: [], named };
		}
	}

	return { positional: params.map(bindValue) };
}

function readRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		if (typeof value === 'bigint') result[key] = Number(value);
		else if (value instanceof Uint8Array) result[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		else result[key] = value;
	}

	return result;
}

function runStatement(statement: StatementSync, bindings: Bindings): StatementResultingChanges {
	return bindings.named ? statement.run(bindings.named) : statement.run(...bindings.positional);
}

function allRows(statement: StatementSync, bindings: Bindings): Record<string, SQLOutputValue>[] {
	const rows = bindings.named ? statement.all(bindings.named) : statement.all(...bindings.positional);
	return rows as Record<string, SQLOutputValue>[];
}

function getRow(statement: StatementSync, bindings: Bindings): Record<string, SQLOutputValue> | undefined {
	const row = bindings.named ? statement.get(bindings.named) : statement.get(...bindings.positional);
	return row as Record<string, SQLOutputValue> | undefined;
}

function splitCallback(args: unknown[]): { params: unknown[]; callback: Callback | undefined } {
	const last = args[args.length - 1];
	if (typeof last !== 'function') return { params: args, callback: undefined };
	return { params: args.slice(0, -1), callback: last as Callback };
}

class Database {
	open = false;
	private connection: DatabaseSync | undefined;

	constructor(filename: string, mode?: number | Callback, callback?: Callback) {
		if (typeof mode === 'function') {
			callback = mode;
			mode = undefined;
		}

		const flags = mode ?? OPEN_READWRITE | OPEN_CREATE;
		let failure: Error | null = null;

		try {
			if (!isValidOpenMode(flags)) throw sqliteError('SQLITE_MISUSE', 'bad parameter or other API misuse');

			const sqlite = loadNodeSqlite();

			if ((flags & OPEN_URI) !== 0 && !supportsUriFilenames(process.versions.node)) {
				throw new Error(
					'SQLite URI filenames, the OPEN_URI flag in DB_FLAGS, require Node.js 22.15.0 or later. Update Node.js to a current 22 or 24 release.'
				);
			}

			this.connection = new sqlite.DatabaseSync(resolveFilename(filename, flags), {
				readOnly: (flags & OPEN_READWRITE) === 0,
				enableDoubleQuotedStringLiterals: true,
				enableForeignKeyConstraints: false,
			});

			this.connection.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
			this.open = true;
		} catch (error) {
			failure = toSqliteError(error);
		}

		if (!callback) {
			if (failure) throw failure;
			return;
		}

		const done = callback;
		process.nextTick(() => done.call(this, failure));
	}

	run(sql: string, ...args: unknown[]): this {
		return this.execute('run', sql, args);
	}

	all(sql: string, ...args: unknown[]): this {
		return this.execute('all', sql, args);
	}

	get(sql: string, ...args: unknown[]): this {
		return this.execute('get', sql, args);
	}

	exec(sql: string, callback?: Callback): this {
		let failure: Error | null = null;

		try {
			this.requireConnection().exec(sql);
		} catch (error) {
			failure = toSqliteError(error);
		}

		if (callback) process.nextTick(() => callback.call(this, failure));
		return this;
	}

	close(callback?: Callback): void {
		let failure: Error | null = null;

		try {
			this.requireConnection().close();
			this.open = false;
		} catch (error) {
			failure = toSqliteError(error);
		}

		if (callback) process.nextTick(() => callback.call(this, failure));
	}

	private requireConnection(): DatabaseSync {
		if (!this.connection || !this.open) throw sqliteError('SQLITE_MISUSE', 'Database is closed');
		return this.connection;
	}

	private execute(kind: 'run' | 'all' | 'get', sql: string, args: unknown[]): this {
		const { params, callback } = splitCallback(args);
		const context: StatementContext = { sql, lastID: 0, changes: 0 };
		let failure: Error | null = null;
		let result: unknown;

		try {
			const statement = this.requireConnection().prepare(sql);
			statement.setReadBigInts(true);
			const bindings = bindParameters(params);

			if (kind === 'run') {
				const changes = runStatement(statement, bindings);
				context.lastID = Number(changes.lastInsertRowid);
				context.changes = Number(changes.changes);
			} else if (kind === 'get') {
				const row = getRow(statement, bindings);
				result = row === undefined ? undefined : readRow(row);
			} else {
				result = allRows(statement, bindings).map(readRow);
			}
		} catch (error) {
			failure = toSqliteError(error);
		}

		if (callback) process.nextTick(() => callback.call(context, failure, result));
		return this;
	}
}

export const sqliteDriver = {
	Database,
	OPEN_READONLY,
	OPEN_READWRITE,
	OPEN_CREATE,
	OPEN_URI,
	OPEN_FULLMUTEX,
	OPEN_SHAREDCACHE,
	OPEN_PRIVATECACHE,
};

let sqliteClient: typeof Knex.Client | undefined;

// The knex internal is required lazily and only for SQLite, so a knex layout change cannot break
// API boot on other vendors.
export function getSqliteClient(): typeof Knex.Client {
	if (sqliteClient) return sqliteClient;

	const KnexSqlite3 = require('knex/lib/dialects/sqlite3/index.js') as typeof Knex.Client;

	sqliteClient = class Client_SQLite3 extends KnexSqlite3 {
		_driver() {
			return sqliteDriver;
		}
	};

	return sqliteClient;
}
