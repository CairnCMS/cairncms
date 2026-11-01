import type { Knex } from 'knex';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const CAIRN_IMMEDIATE = Symbol('cairnBeginImmediate');

type KnexSqliteTransaction = {
	client: { raw(sql: string): { connection(connection: unknown): Promise<unknown> } };
	query(connection: unknown, sql: string): unknown;
	begin(connection: unknown): unknown;
	commit(connection: unknown, value: unknown): unknown;
	_onAcquire(container: unknown, connection: unknown): Promise<unknown>;
	_logAndDispose(connection: unknown, message: string, cause: unknown): void;
};

type SqliteTransactionClass = new (...args: unknown[]) => KnexSqliteTransaction;

let transactionClass: SqliteTransactionClass | undefined;

const installed = new WeakSet<object>();

// The knex internal is required lazily and only for SQLite, so a knex layout change cannot break
// API boot on other vendors.
function getTransactionClass(): SqliteTransactionClass {
	if (transactionClass) return transactionClass;

	const SqliteTransaction =
		require('knex/lib/dialects/sqlite3/execution/sqlite-transaction.js') as SqliteTransactionClass;

	transactionClass = class CairnSqliteTransaction extends SqliteTransaction {
		private readonly cairnImmediate: boolean;
		private cairnCommitStarted = false;

		constructor(...args: unknown[]) {
			super(...args);
			const config = args[2] as Record<PropertyKey, unknown> | undefined;
			this.cairnImmediate = config?.[CAIRN_IMMEDIATE] === true;
		}

		override begin(connection: unknown): unknown {
			if (!this.cairnImmediate) return super.begin(connection);
			return this.query(connection, 'BEGIN IMMEDIATE;');
		}

		override commit(connection: unknown, value: unknown): unknown {
			this.cairnCommitStarted = true;
			return super.commit(connection, value);
		}

		/**
		 * SQLite keeps a transaction open when its COMMIT fails, and knex releases the connection
		 * without a ROLLBACK. The rollback has to finish before the connection returns to the pool,
		 * and a connection whose rollback fails is disposed instead of reused.
		 */
		override async _onAcquire(container: unknown, connection: unknown): Promise<unknown> {
			try {
				return await super._onAcquire(container, connection);
			} catch (error) {
				if (this.cairnCommitStarted) {
					try {
						await this.client.raw('ROLLBACK').connection(connection);
					} catch (rollbackError) {
						this._logAndDispose(connection, 'Failed to roll back after a failed commit', rollbackError);
					}
				}

				throw error;
			}
		}
	};

	return transactionClass;
}

export function installSqliteTransaction(database: Knex): void {
	const client = (database as unknown as { client: { transaction: (...args: unknown[]) => unknown } }).client;
	if (installed.has(client)) return;

	const SqliteTransaction = getTransactionClass();

	client.transaction = function (this: unknown, ...args: unknown[]) {
		return new SqliteTransaction(this, ...args);
	};

	installed.add(client);
}
