import type { Knex } from 'knex';
import type { ActionEventParams } from '../types/index.js';
import { getDatabaseClient } from './index.js';
import { CAIRN_IMMEDIATE, installSqliteTransaction } from './sqlite-transaction.js';

const bound = new WeakSet<object>();
const contexts = new WeakMap<object, LifecycleContext>();

export interface LifecycleContext {
	events: ActionEventParams[];
	responseCacheDirty: boolean;
	systemCacheDirty: boolean;
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
		installSqliteTransaction(database);
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
