import type { Knex } from 'knex';
import { createRequire } from 'node:module';
import type { ActionEventParams } from '../types/index.js';
import { getDatabaseClient } from './index.js';

const require = createRequire(import.meta.url);

const SqliteTransaction = require('knex/lib/dialects/sqlite3/execution/sqlite-transaction.js') as {
	new (...args: unknown[]): {
		query(connection: unknown, sql: string): unknown;
		begin(connection: unknown): unknown;
	};
};

const CAIRN_IMMEDIATE = Symbol('cairnBeginImmediate');

const bound = new WeakSet<object>();
const adapted = new WeakSet<object>();
const contexts = new WeakMap<object, LifecycleContext>();

export interface LifecycleContext {
	events: ActionEventParams[];
	responseCacheDirty: boolean;
	systemCacheDirty: boolean;
}

class CairnImmediateTransaction extends SqliteTransaction {
	private readonly cairnImmediate: boolean;

	constructor(...args: unknown[]) {
		super(...args);
		const config = args[2] as Record<PropertyKey, unknown> | undefined;
		this.cairnImmediate = config?.[CAIRN_IMMEDIATE] === true;
	}

	override begin(connection: unknown): unknown {
		if (!this.cairnImmediate) return super.begin(connection);
		return this.query(connection, 'BEGIN IMMEDIATE;');
	}
}

function ensureImmediateAdapter(database: Knex): void {
	const client = (database as unknown as { client: { transaction: (...args: unknown[]) => unknown } }).client;
	if (adapted.has(client)) return;

	client.transaction = function (this: unknown, ...args: unknown[]) {
		return new CairnImmediateTransaction(this, ...args);
	};

	adapted.add(client);
}

export function isBoundSerializable(trx: unknown): boolean {
	if (trx === null || (typeof trx !== 'object' && typeof trx !== 'function')) return false;
	return bound.has(trx as object);
}

export function lifecycleContextFor(trx: unknown): LifecycleContext | undefined {
	if (trx === null || (typeof trx !== 'object' && typeof trx !== 'function')) return undefined;
	return contexts.get(trx as object);
}

export async function runInBoundSerializable<T>(
	database: Knex,
	fn: (trx: Knex.Transaction) => Promise<T>,
	flush: (context: LifecycleContext) => Promise<void>
): Promise<T> {
	const client = getDatabaseClient(database);

	let config: Knex.TransactionConfig;

	if (client === 'sqlite') {
		ensureImmediateAdapter(database);
		config = { [CAIRN_IMMEDIATE]: true } as unknown as Knex.TransactionConfig;
	} else {
		config = { isolationLevel: 'serializable' };
	}

	const context: LifecycleContext = { events: [], responseCacheDirty: false, systemCacheDirty: false };

	const result = await database.transaction(async (trx) => {
		bound.add(trx);
		contexts.set(trx, context);

		try {
			return await fn(trx);
		} finally {
			bound.delete(trx);
			contexts.delete(trx);
		}
	}, config);

	await flush(context);

	return result;
}
