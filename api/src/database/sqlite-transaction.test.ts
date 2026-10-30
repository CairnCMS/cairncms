import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInBoundSerializable } from './bound-transaction.js';
import { sqliteAfterCreate } from './connection-hooks.js';
import { getSqliteClient } from './sqlite-driver.js';
import { installSqliteTransaction } from './sqlite-transaction.js';

describe('sqlite transaction (failed commit)', () => {
	let dir: string | undefined;
	let db: Knex | undefined;
	let connectionsCreated = 0;
	const warnings: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();

		if (db) await db.destroy();
		db = undefined;

		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;

		connectionsCreated = 0;
		warnings.length = 0;
	});

	async function setup(): Promise<Knex> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-sqlite-commit-'));

		const database = knex.default({
			client: getSqliteClient(),
			connection: { filename: path.join(dir, `commit-${randomUUID()}.db`) },
			useNullAsDefault: true,
			log: { warn: (message: string) => warnings.push(message) },
			pool: {
				min: 1,
				max: 1,
				afterCreate: (conn: unknown, done: Parameters<typeof sqliteAfterCreate>[1]) => {
					connectionsCreated++;
					sqliteAfterCreate(conn, done);
				},
			},
		});

		db = database;
		installSqliteTransaction(database);

		await database.raw('create table parents (id integer primary key)');

		await database.raw(
			'create table children (id integer primary key, parent integer references parents(id) deferrable initially deferred)'
		);

		return database;
	}

	async function counts(database: Knex): Promise<{ parents: number; children: number }> {
		const [parents] = await database('parents').count({ n: '*' });
		const [children] = await database('children').count({ n: '*' });
		return { parents: Number(parents!['n']), children: Number(children!['n']) };
	}

	it('rolls back a transaction whose commit fails and reuses the connection', async () => {
		const database = await setup();

		await expect(
			database.transaction(async (trx) => {
				await trx('children').insert({ id: 1, parent: 99 });
			})
		).rejects.toMatchObject({
			code: 'SQLITE_CONSTRAINT',
			message: expect.stringMatching(/FOREIGN KEY constraint failed/),
		});

		expect(await counts(database)).toEqual({ parents: 0, children: 0 });

		await database.transaction(async (trx) => {
			await trx('parents').insert({ id: 1 });
		});

		expect(await counts(database)).toEqual({ parents: 1, children: 0 });
		expect(connectionsCreated).toBe(1);
	});

	it('rolls back the outer transaction when its commit fails after a nested transaction', async () => {
		const database = await setup();

		await expect(
			database.transaction(async (trx) => {
				await trx('parents').insert({ id: 1 });

				await trx.transaction(async (nested) => {
					await nested('children').insert({ id: 1, parent: 99 });
				});
			})
		).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		expect(await counts(database)).toEqual({ parents: 0, children: 0 });

		await database.transaction(async (trx) => {
			await trx('parents').insert({ id: 2 });
		});

		expect(await counts(database)).toEqual({ parents: 1, children: 0 });
		expect(connectionsCreated).toBe(1);
	});

	it('rolls back a bound serializable transaction whose commit fails and skips its flush', async () => {
		const database = await setup();
		let flushes = 0;

		const flush = async () => {
			flushes++;
		};

		await expect(
			runInBoundSerializable(
				database,
				async (trx) => {
					await trx('children').insert({ id: 1, parent: 99 });
				},
				flush
			)
		).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		expect(flushes).toBe(0);
		expect(await counts(database)).toEqual({ parents: 0, children: 0 });

		await runInBoundSerializable(
			database,
			async (trx) => {
				await trx('parents').insert({ id: 1 });
			},
			flush
		);

		expect(flushes).toBe(1);
		expect(await counts(database)).toEqual({ parents: 1, children: 0 });
		expect(connectionsCreated).toBe(1);
	});

	it('leaves an explicit SQL transaction open after a failed commit so it can be repaired and retried', async () => {
		const database = await setup();
		const connection = await database.client.acquireConnection();

		try {
			const run = (sql: string) => database.raw(sql).connection(connection);

			await run('BEGIN');
			await run('insert into children (id, parent) values (1, 1)');
			await expect(run('COMMIT')).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });
			await run('insert into parents (id) values (1)');
			await run('COMMIT');
		} finally {
			await database.client.releaseConnection(connection);
		}

		expect(await counts(database)).toEqual({ parents: 1, children: 1 });
	});

	it('disposes the connection when the rollback after a failed commit also fails', async () => {
		const database = await setup();
		const raw = database.client.raw.bind(database.client);

		vi.spyOn(database.client, 'raw').mockImplementation((...args: unknown[]) => {
			if (args[0] === 'ROLLBACK') return { connection: () => Promise.reject(new Error('rollback unavailable')) };
			return raw(...args);
		});

		await expect(
			database.transaction(async (trx) => {
				await trx('children').insert({ id: 1, parent: 99 });
			})
		).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		vi.restoreAllMocks();

		expect(warnings.some((message) => message.includes('Failed to roll back after a failed commit'))).toBe(true);
		expect(await counts(database)).toEqual({ parents: 0, children: 0 });
		expect(connectionsCreated).toBe(2);

		await database.transaction(async (trx) => {
			await trx('parents').insert({ id: 1 });
		});

		expect(await counts(database)).toEqual({ parents: 1, children: 0 });
	});
});
