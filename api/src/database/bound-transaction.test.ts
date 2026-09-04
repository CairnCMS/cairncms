import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('bound-transaction (sqlite immediate-lock contention)', () => {
	let dir: string | undefined;
	let holder: Knex | undefined;
	let contender: Knex | undefined;

	afterEach(async () => {
		if (holder) await holder.destroy();
		if (contender) await contender.destroy();
		holder = contender = undefined;

		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	function fileDatabase(filename: string, busyTimeout: number): Knex {
		return knex.default({
			client: 'sqlite3',
			connection: { filename },
			useNullAsDefault: true,
			pool: {
				min: 1,
				max: 1,
				afterCreate: (conn: { run: (sql: string, cb: (err: unknown) => void) => void }, done: (err: unknown) => void) =>
					conn.run(`PRAGMA busy_timeout = ${busyTimeout}`, done),
			},
		});
	}

	it('fails the second immediate writer with SQLITE_BUSY, runs no effect for it, and lets the holder commit', async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-sqlite-busy-'));
		const filename = path.join(dir, `contention-${randomUUID()}.db`);

		holder = fileDatabase(filename, 2000);
		contender = fileDatabase(filename, 50);

		await holder.raw('create table t (id integer primary key)');

		let releaseHolder!: () => void;

		const held = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});

		let holderReady!: () => void;

		const ready = new Promise<void>((resolve) => {
			holderReady = resolve;
		});

		let holderFlushed = false;

		const holderRun = runInBoundSerializable(
			holder,
			async (trx) => {
				await trx('t').insert({ id: 1 });
				holderReady();
				await held;
			},
			async () => {
				holderFlushed = true;
			}
		);

		await ready;

		let contenderError: { code?: unknown } | undefined;
		let contenderFlushed = false;

		try {
			try {
				await runInBoundSerializable(
					contender,
					async (trx) => {
						await trx('t').insert({ id: 2 });
					},
					async () => {
						contenderFlushed = true;
					}
				);
			} catch (err) {
				contenderError = err as { code?: unknown };
			}
		} finally {
			// Always release and settle the holder so teardown never waits on an open transaction.
			releaseHolder();
			await holderRun;
		}

		expect(contenderError?.code).toBe('SQLITE_BUSY');
		expect(contenderFlushed).toBe(false);
		expect(holderFlushed).toBe(true);

		const rows = await holder('t').select('id').orderBy('id');
		expect(rows.map((row) => row.id)).toEqual([1]);
	});
});
