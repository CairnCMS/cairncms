import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getDatabase sqlite connection wiring', () => {
	let tmpFile: string;
	let db: Knex | undefined;

	beforeEach(() => {
		vi.resetModules();
		tmpFile = join(tmpdir(), `cairncms-conn-hooks-${randomUUID()}.db`);
	});

	afterEach(async () => {
		if (db) {
			await db.destroy();
			db = undefined;
		}

		rmSync(tmpFile, { force: true });
		vi.restoreAllMocks();
		vi.doUnmock('../env.js');
		vi.doUnmock('node:module');
		vi.resetModules();
	});

	function mockSqliteEnv(extra: Record<string, unknown> = {}): void {
		vi.doMock('../env.js', async (importOriginal) => {
			const actual = await importOriginal<typeof import('../env.js')>();

			const withoutDbKeys = Object.fromEntries(
				Object.entries(actual.getEnv()).filter(([key]) => key.startsWith('DB_') === false)
			);

			const values = { ...withoutDbKeys, DB_CLIENT: 'sqlite3', DB_FILENAME: tmpFile, ...extra };

			return { ...actual, default: values, getEnv: () => values };
		});
	}

	it('runs SQLite on the node:sqlite client', async () => {
		mockSqliteEnv();

		const { default: getDatabase, getDatabaseClient } = await import('./index.js');
		const { getSqliteClient } = await import('./sqlite-driver.js');
		db = getDatabase();

		expect(db.client).toBeInstanceOf(getSqliteClient());
		expect(getDatabaseClient(db)).toBe('sqlite');
		expect(await db.raw('select 1 as v')).toEqual([{ v: 1 }]);
	});

	it('limits the SQLite pool to one connection and warns when more were configured', async () => {
		mockSqliteEnv({ DB_POOL__MIN: 2, DB_POOL__MAX: 4 });

		const { default: logger } = await import('../logger.js');
		const warn = vi.spyOn(logger, 'warn');
		const { default: getDatabase } = await import('./index.js');
		db = getDatabase();

		expect((db.client as any).config.pool).toMatchObject({ min: 1, max: 1 });
		expect(await db.raw('select 1 as v')).toEqual([{ v: 1 }]);

		expect(warn).toHaveBeenCalledWith(
			'SQLite uses a single database connection. DB_POOL__MIN and DB_POOL__MAX are limited to 1.'
		);
	});

	it('stops startup with a named diagnostic when node:sqlite is unavailable', async () => {
		mockSqliteEnv();

		vi.doMock('node:module', async (importOriginal) => {
			const actual = await importOriginal<typeof import('node:module')>();

			const createRequire = (url: string | URL) => {
				const realRequire = actual.createRequire(url);

				return Object.assign((id: string) => {
					if (id === 'node:sqlite') {
						throw Object.assign(new Error('No such built-in module: node:sqlite'), {
							code: 'ERR_UNKNOWN_BUILTIN_MODULE',
						});
					}

					return realRequire(id);
				}, realRequire);
			};

			return { ...actual, default: { ...actual, createRequire }, createRequire };
		});

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const { default: logger } = await import('../logger.js');
		const error = vi.spyOn(logger, 'error');
		const { default: getDatabase, validateDatabaseConnection } = await import('./index.js');
		db = getDatabase();

		await validateDatabaseConnection(db);

		expect(exit).toHaveBeenCalledWith(1);

		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining('SQLite requires the node:sqlite module, available in Node.js 22.13.0'),
			})
		);
	});

	it('applies foreign_keys and busy_timeout on a real sqlite connection', async () => {
		mockSqliteEnv();

		const { default: getDatabase } = await import('./index.js');
		const { sqliteAfterCreate } = await import('./connection-hooks.js');
		db = getDatabase();

		expect((db.client as any).config.pool.afterCreate).toBe(sqliteAfterCreate);

		const foreignKeys = await db.raw('PRAGMA foreign_keys');
		const busyTimeout = await db.raw('PRAGMA busy_timeout');

		expect(foreignKeys[0].foreign_keys).toBe(1);
		expect(busyTimeout[0].timeout).toBe(5000);
	});

	it('rolls back a transaction whose commit fails, from the first transaction onward', async () => {
		mockSqliteEnv();

		const { default: getDatabase } = await import('./index.js');
		db = getDatabase();

		await db.raw('create table parents (id integer primary key)');

		await db.raw(
			'create table children (id integer primary key, parent integer references parents(id) deferrable initially deferred)'
		);

		await expect(
			db.transaction(async (trx) => {
				await trx('children').insert({ id: 1, parent: 99 });
			})
		).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		await db.transaction(async (trx) => {
			await trx('parents').insert({ id: 1 });
		});

		expect(await db('children').count({ n: '*' })).toEqual([{ n: 0 }]);
		expect(await db('parents').count({ n: '*' })).toEqual([{ n: 1 }]);
	});
});
