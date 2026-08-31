import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { isBoundSerializable, lifecycleContextFor, runInBoundSerializable } from './bound-transaction.js';

const noopFlush = () => Promise.resolve();

describe('bound-transaction (sqlite adapter)', () => {
	let active: Knex | undefined;

	afterEach(async () => {
		if (active) await active.destroy();
		active = undefined;
	});

	function makeSqlite(): Knex {
		const db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
		});

		active = db;
		return db;
	}

	it('emits exactly BEGIN, BEGIN IMMEDIATE, BEGIN across normal, bound, normal transactions', async () => {
		const db = makeSqlite();
		const begins: string[] = [];

		db.on('query', (q: { sql: string }) => {
			const sql = q.sql.trim();
			if (/^begin/i.test(sql)) begins.push(sql);
		});

		await db.raw('create table t (id integer primary key)');

		await db.transaction(async (trx) => {
			await trx('t').insert({ id: 1 });
		});

		await runInBoundSerializable(
			db,
			async (trx) => {
				await trx('t').insert({ id: 2 });
			},
			noopFlush
		);

		await db.transaction(async (trx) => {
			await trx('t').insert({ id: 3 });
		});

		expect(begins).toEqual(['BEGIN;', 'BEGIN IMMEDIATE;', 'BEGIN;']);
	});

	it('brands the bound transaction and associates a lifecycle context', async () => {
		const db = makeSqlite();
		let brandedInside = false;
		let contextInside = false;

		await runInBoundSerializable(
			db,
			async (trx) => {
				brandedInside = isBoundSerializable(trx);
				contextInside = lifecycleContextFor(trx) !== undefined;
			},
			noopFlush
		);

		expect(brandedInside).toBe(true);
		expect(contextInside).toBe(true);
		expect(isBoundSerializable(db)).toBe(false);
		expect(lifecycleContextFor(db)).toBeUndefined();
	});

	it('runs the flush after commit and skips it on rollback', async () => {
		const db = makeSqlite();
		await db.raw('create table t (id integer primary key)');

		let flushSawCommittedRow: boolean | undefined;

		await runInBoundSerializable(
			db,
			async (trx) => {
				await trx('t').insert({ id: 1 });
			},
			async () => {
				flushSawCommittedRow = (await db('t').where({ id: 1 })).length === 1;
			}
		);

		expect(flushSawCommittedRow).toBe(true);

		let rollbackFlushed = false;

		await expect(
			runInBoundSerializable(
				db,
				async (trx) => {
					await trx('t').insert({ id: 2 });
					throw new Error('rollback');
				},
				async () => {
					rollbackFlushed = true;
				}
			)
		).rejects.toThrow('rollback');

		expect((await db('t').where({ id: 2 })).length).toBe(0);
		expect(rollbackFlushed).toBe(false);
	});

	it('clears the brand and context after commit and after rollback', async () => {
		const db = makeSqlite();
		await db.raw('create table t (id integer primary key)');

		let committedTrx: unknown;

		await runInBoundSerializable(
			db,
			async (trx) => {
				committedTrx = trx;
				await trx('t').insert({ id: 1 });
			},
			noopFlush
		);

		expect(isBoundSerializable(committedTrx)).toBe(false);
		expect(lifecycleContextFor(committedTrx)).toBeUndefined();

		let rolledBackTrx: unknown;

		await expect(
			runInBoundSerializable(
				db,
				async (trx) => {
					rolledBackTrx = trx;
					throw new Error('rollback');
				},
				noopFlush
			)
		).rejects.toThrow('rollback');

		expect(isBoundSerializable(rolledBackTrx)).toBe(false);
		expect(lifecycleContextFor(rolledBackTrx)).toBeUndefined();
	});
});
