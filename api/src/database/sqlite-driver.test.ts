import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSqliteClient, sqliteDriver, supportsUriFilenames } from './sqlite-driver.js';

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
const uriSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 15);
const nulTextSupported = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 16);

let dir: string;
const open: Knex[] = [];

function connect(filename: string, flags?: string[]): Knex {
	const db = knex.default({
		client: getSqliteClient(),
		connection: flags ? { filename, flags } : { filename },
		useNullAsDefault: true,
		pool: { min: 1, max: 1 },
	});

	open.push(db);
	return db;
}

function file(name = `driver-${randomUUID()}.db`): string {
	return path.join(dir, name);
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-sqlite-driver-'));
});

afterEach(async () => {
	await Promise.all(open.splice(0).map((db) => db.destroy()));
	await fs.rm(dir, { recursive: true, force: true });
});

describe('sqlite driver adapter (values)', () => {
	it.each<[string, unknown, 'txt' | 'num', string, string]>([
		['an int32 integer', 41, 'txt', 'text', `'41'`],
		['a negative int32 integer', -7, 'txt', 'text', `'-7'`],
		['negative zero', -0, 'txt', 'text', `'0'`],
		['the int32 maximum', 2147483647, 'txt', 'text', `'2147483647'`],
		['an integer beyond int32', 2147483648, 'txt', 'text', `'2147483648.0'`],
		['an integer beyond int32 into an INTEGER column', 3000000000, 'num', 'integer', '3000000000'],
		['a fraction', 1.5, 'txt', 'text', `'1.5'`],
		['infinity', Infinity, 'txt', 'text', `'Inf'`],
		['negative infinity', -Infinity, 'txt', 'text', `'-Inf'`],
		['a very large number', 1e300, 'txt', 'text', `'1.0e+300'`],
		['NaN', NaN, 'txt', 'null', 'NULL'],
		['true', true, 'txt', 'text', `'1'`],
		['false', false, 'txt', 'text', `'0'`],
		['a string', 'abc', 'txt', 'text', `'abc'`],
		['a date', new Date(Date.UTC(2026, 0, 2)), 'txt', 'text', `'1767312000000.0'`],
		['an invalid date', new Date('invalid'), 'txt', 'null', 'NULL'],
		['a regular expression', /a/g, 'txt', 'text', `'/a/g'`],
		['a bigint', 41n, 'txt', 'null', 'NULL'],
		['an array', [1, 2], 'txt', 'text', `'[object Object]'`],
		['a plain object, serialized by knex', { a: 1 }, 'txt', 'text', `'{"a":1}'`],
		['a typed array', new Uint8Array([1, 2]), 'txt', 'blob', `X'0102'`],
	])('stores %s as the old driver did', async (_label, value, column, type, quoted) => {
		const db = connect(':memory:');
		await db.raw('create table t (txt text, num integer)');
		await db('t').insert({ [column]: value });

		const [row] = await db.raw(`select typeof(${column}) as type, quote(${column}) as quoted from t`);
		expect(row).toEqual({ type, quoted });
	});

	it('stores null and a buffer as null and a blob', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (a text, b blob)');
		await db('t').insert({ a: null, b: Buffer.from('cafe', 'hex') });

		const [row] = await db('t').select('a', 'b');
		expect(row.a).toBeNull();
		expect(Buffer.isBuffer(row.b)).toBe(true);
		expect(row.b.toString('hex')).toBe('cafe');
	});

	it('formats a high-precision double in a TEXT column the way the bundled engine does', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (txt text)');
		await db('t').insert({ txt: 1.0000000000000002 });

		const [{ version }] = await db.raw('select sqlite_version() as version');
		const [major = 0, minor = 0] = String(version).split('.').map(Number);
		const fullPrecision = major > 3 || (major === 3 && minor >= 52);

		const [row] = await db('t').select('txt');
		expect(row.txt).toBe(fullPrecision ? '1.0000000000000002' : '1.0');
	});

	it('stores text with embedded and leading NUL whole, and reads it whole from Node 24.16', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (id integer primary key, v text)');

		await db('t').insert([
			{ id: 1, v: 'before\u0000after' },
			{ id: 2, v: '\u0000after' },
		]);

		expect(await db.raw('select hex(v) as stored from t order by id')).toEqual([
			{ stored: '6265666F7265006166746572' },
			{ stored: '006166746572' },
		]);

		expect(await db('t').orderBy('id').pluck('v')).toEqual(
			nulTextSupported ? ['before\u0000after', '\u0000after'] : ['before', '']
		);
	});

	it('reads integers beyond 2^53 as rounded numbers and rows as plain objects', async () => {
		const db = connect(':memory:');
		const [row] = await db.raw('select 9007199254740993 as n, 41 as small');

		expect(row).toEqual({ n: 9007199254740992, small: 41 });
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
	});

	it('matches and rejects values stored by the old driver', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (v text unique)');
		await db.raw(`insert into t (v) values ('41'), ('2147483648.0'), ('1.5'), ('1')`);

		for (const value of [41, 2147483648, 1.5, true]) {
			expect(await db('t').where('v', value).count({ n: '*' })).toEqual([{ n: 1 }]);
			await expect(db('t').insert({ v: value })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });
		}
	});
});

describe('sqlite driver adapter (statements)', () => {
	it('returns insert ids, update and delete counts, and returning rows', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (id integer primary key, name text)');

		expect(await db('t').insert({ name: 'a' })).toEqual([1]);
		expect(await db('t').insert({ name: 'b' }, ['id', 'name'])).toEqual([{ id: 2, name: 'b' }]);
		expect(await db('t').update({ name: 'c' })).toBe(2);
		expect(await db('t').where('id', 1).del()).toBe(1);
		expect(await db('t').first('name')).toEqual({ name: 'c' });
		expect(await db('t').pluck('id')).toEqual([2]);
	});

	it('reports errors with the old driver message, code, and errno', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (id integer primary key)');
		await db('t').insert({ id: 1 });

		await expect(db('t').insert({ id: 1 })).rejects.toMatchObject({
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
			message: expect.stringContaining('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.id'),
		});

		await expect(db.raw('select from')).rejects.toMatchObject({
			code: 'SQLITE_ERROR',
			errno: 1,
			message: expect.stringContaining('SQLITE_ERROR: near "from": syntax error'),
		});

		await expect(db('missing').select()).rejects.toMatchObject({
			code: 'SQLITE_ERROR',
			message: expect.stringContaining('SQLITE_ERROR: no such table: missing'),
		});
	});

	it('rolls back a failed transaction and commits a nested savepoint', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (id integer primary key)');

		await expect(
			db.transaction(async (trx) => {
				await trx('t').insert({ id: 1 });
				await trx('t').insert({ id: 1 });
			})
		).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		await db.transaction(async (trx) => {
			await trx('t').insert({ id: 2 });

			await trx.transaction(async (nested) => {
				await nested('t').insert({ id: 3 });
			});
		});

		expect(await db('t').pluck('id')).toEqual([2, 3]);
	});

	it('accepts double-quoted string literals in views and triggers', async () => {
		const db = connect(':memory:');
		await db.raw('create table t (id integer primary key, label text)');
		await db.raw('create table audit (note text)');
		await db.raw('create view v as select "literal" as x');
		await db.raw('create trigger tr after insert on t begin insert into audit (note) values ("inserted"); end');
		await db('t').insert({ id: 1 });

		expect(await db('v').first('x')).toEqual({ x: 'literal' });
		expect(await db('audit').pluck('note')).toEqual(['inserted']);
	});

	it('leaves foreign key enforcement off until the connection hook turns it on', async () => {
		const db = connect(':memory:');
		expect(await db.raw('pragma foreign_keys')).toEqual([{ foreign_keys: 0 }]);
	});

	it('calls back after the current tick with the statement context', async () => {
		const order: string[] = [];

		const result = await new Promise<{ lastID: number; changes: number }>((resolve, reject) => {
			const connection = new sqliteDriver.Database(':memory:', (error) => {
				if (error) return reject(error);

				connection.run('create table t (id integer primary key)', () => {
					connection.run('insert into t (id) values (?)', [5], function (this: unknown, insertError: Error | null) {
						if (insertError) return reject(insertError);
						order.push('callback');
						const context = this as { lastID: number; changes: number };
						connection.close();
						resolve({ lastID: context.lastID, changes: context.changes });
					});

					order.push('after call');
				});
			});
		});

		expect(order).toEqual(['after call', 'callback']);
		expect(result).toEqual({ lastID: 5, changes: 1 });
	});

	it('binds positional and prefixed named parameters', async () => {
		const rows = await new Promise<unknown[]>((resolve, reject) => {
			const connection = new sqliteDriver.Database(':memory:', () => {
				connection.all('select ? as a, ? as b', 1, 'x', (error: Error | null, positional: unknown) => {
					if (error) return reject(error);

					connection.all(
						'select $a as a, :b as b',
						{ $a: 2, ':b': 'y' },
						(namedError: Error | null, named: unknown) => {
							connection.close();
							if (namedError) return reject(namedError);
							resolve([positional, named]);
						}
					);
				});
			});
		});

		expect(rows).toEqual([[{ a: 1, b: 'x' }], [{ a: 2, b: 'y' }]]);
	});

	function quoteThroughDriver(sql: string, ...params: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const connection = new sqliteDriver.Database(':memory:', () => {
				connection.all(sql, ...params, (error: Error | null, result: unknown) => {
					connection.close();
					if (error) return reject(error);
					resolve(result);
				});
			});
		});
	}

	it('binds objects that reach the driver as the text [object Object]', async () => {
		const rows = await quoteThroughDriver('select quote(?) as a, quote(?) as b, quote(?) as c, quote(?) as d', [
			[1, 2],
			{ a: 1 },
			{ toString: () => 'x' },
			new String('x'),
		]);

		expect(rows).toEqual([
			{ a: `'[object Object]'`, b: `'[object Object]'`, c: `'[object Object]'`, d: `'[object Object]'` },
		]);
	});

	it('binds a symbol as NULL and a lone regular expression as a positional value', async () => {
		expect(await quoteThroughDriver('select quote(?) as v', [Symbol('s')])).toEqual([{ v: 'NULL' }]);
		expect(await quoteThroughDriver('select quote(?) as v', /a/)).toEqual([{ v: `'/a/'` }]);
	});
});

describe('sqlite driver adapter (flags and filenames)', () => {
	it('exports the old driver open flags', () => {
		expect(sqliteDriver).toMatchObject({
			OPEN_READONLY: 1,
			OPEN_READWRITE: 2,
			OPEN_CREATE: 4,
			OPEN_URI: 64,
			OPEN_FULLMUTEX: 65536,
			OPEN_SHAREDCACHE: 131072,
			OPEN_PRIVATECACHE: 262144,
		});
	});

	it('rejects OPEN_READONLY combined with the read-write flags knex always sets', async () => {
		const db = connect(file(), ['OPEN_READONLY']);

		await expect(db.raw('select 1')).rejects.toMatchObject({
			code: 'SQLITE_MISUSE',
			message: expect.stringContaining('SQLITE_MISUSE: bad parameter or other API misuse'),
		});
	});

	it.each(['OPEN_FULLMUTEX', 'OPEN_PRIVATECACHE', 'OPEN_SHAREDCACHE'])(
		'opens, reads, and writes with %s',
		async (flag) => {
			const db = connect(file(), [flag]);
			await db.raw('create table t (id integer primary key)');
			await db('t').insert({ id: 1 });

			expect(await db('t').pluck('id')).toEqual([1]);
		}
	);

	it('opens a file: name without OPEN_URI as a literal relative path', async () => {
		const target = file('literal.db');
		const seed = connect(target);
		await seed.raw('create table t (id integer)');

		const db = connect(`file:${target}?mode=ro`);
		await expect(db.raw('select * from t')).rejects.toMatchObject({ code: 'SQLITE_CANTOPEN' });
	});

	it('opens :memory: and the empty filename as private databases', async () => {
		for (const filename of [':memory:', '']) {
			const db = connect(filename);
			await db.raw('create table t (id integer)');
			expect(await db('t').pluck('id')).toEqual([]);
		}
	});

	it('reports a missing directory as SQLITE_CANTOPEN', async () => {
		const db = connect(path.join(dir, 'missing', 'x.db'));
		await expect(db.raw('select 1')).rejects.toMatchObject({ code: 'SQLITE_CANTOPEN' });
	});

	it.each([
		['22.14.0', false],
		['22.15.0', true],
		['23.9.1', false],
		['23.10.0', true],
		['24.0.0', true],
	])('treats Node.js %s as URI capable: %s', (version, supported) => {
		expect(supportsUriFilenames(version)).toBe(supported);
	});

	it('refuses OPEN_URI and opens plain paths on a Node.js release without URI filenames', async () => {
		const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
		Object.defineProperty(process.versions, 'node', { ...original, value: '22.14.0' });

		try {
			const uri = connect(file(), ['OPEN_URI']);

			await expect(uri.raw('select 1')).rejects.toThrow(
				'SQLite URI filenames, the OPEN_URI flag in DB_FLAGS, require Node.js 22.15.0 or later.'
			);

			const plain = connect(file());
			expect(await plain.raw('select 1 as v')).toEqual([{ v: 1 }]);
		} finally {
			Object.defineProperty(process.versions, 'node', original);
		}
	});

	describe.skipIf(!uriSupported)('with URI support', () => {
		it('honors mode=ro and immutable=1 under OPEN_URI', async () => {
			const target = file('uri.db');
			const seed = connect(target);
			await seed.raw('create table t (id integer)');
			await seed('t').insert({ id: 1 });

			for (const parameter of ['mode=ro', 'immutable=1']) {
				const db = connect(`file:${target}?${parameter}`, ['OPEN_URI']);
				expect(await db('t').pluck('id')).toEqual([1]);
				await expect(db('t').insert({ id: 2 })).rejects.toMatchObject({ code: 'SQLITE_READONLY' });
			}
		});

		it('attaches the same shared-cache database only once when both URIs ask for cache=shared', async () => {
			const target = file('shared.db');
			const db = connect(`file:${target}?cache=shared`, ['OPEN_URI']);

			await expect(db.raw(`attach database 'file:${target}?cache=shared' as other`)).rejects.toMatchObject({
				message: expect.stringContaining('database is already attached'),
			});
		});

		it('reads an attached file: name as a URI and a plain path literally', async () => {
			const uriTarget = file('aux.db');
			const literalTarget = file('file:aux.db?mode=ro');

			for (const [target, value] of [
				[uriTarget, 'uri'],
				[literalTarget, 'literal'],
			]) {
				const seed = connect(target!);
				await seed.raw('create table t (v text)');
				await seed('t').insert({ v: value });
			}

			const db = connect(file());

			await db.raw(`attach database 'file:${uriTarget}?mode=ro' as a`);
			expect(await db.raw('select v from a.t')).toEqual([{ v: 'uri' }]);
			await db.raw('detach database a');

			await db.raw(`attach database '${literalTarget}' as b`);
			expect(await db.raw('select v from b.t')).toEqual([{ v: 'literal' }]);
		});
	});
});
