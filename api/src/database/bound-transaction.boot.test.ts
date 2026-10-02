import { createRequire } from 'node:module';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SQLITE_INTERNAL = 'knex/lib/dialects/sqlite3/execution/sqlite-transaction.js';
const realRequire = createRequire(import.meta.url);

describe('bound-transaction boot isolation', () => {
	let requireSpy: ReturnType<typeof vi.fn>;
	let getClient: ReturnType<typeof vi.fn>;
	let active: Knex | undefined;

	beforeEach(() => {
		vi.resetModules();
		requireSpy = vi.fn((id: string) => realRequire(id));
		getClient = vi.fn();

		vi.doMock('node:module', async (importOriginal) => {
			const actual = await importOriginal<typeof import('node:module')>();
			return { ...actual, default: actual, createRequire: () => requireSpy };
		});

		vi.doMock('./index.js', () => ({ default: vi.fn(), getDatabaseClient: getClient }));
	});

	afterEach(async () => {
		vi.doUnmock('node:module');
		vi.doUnmock('./index.js');
		vi.resetModules();

		if (active) {
			await active.destroy();
			active = undefined;
		}
	});

	function requiredInternal(): boolean {
		return requireSpy.mock.calls.some(([id]) => id === SQLITE_INTERNAL);
	}

	it('requires the knex sqlite internal only for a sqlite transaction, never on import or for other vendors', async () => {
		const mod = await import('./bound-transaction.js');

		expect(requiredInternal()).toBe(false);

		getClient.mockReturnValue('postgres');
		let capturedConfig: unknown;

		const fakeDatabase = {
			client: {},
			transaction: async (fn: (trx: unknown) => Promise<unknown>, config: unknown) => {
				capturedConfig = config;
				return fn({});
			},
		} as unknown as Knex;

		await mod.runInBoundSerializable(
			fakeDatabase,
			async () => 'ok',
			async () => undefined
		);

		expect(capturedConfig).toEqual({ isolationLevel: 'serializable' });
		expect(requiredInternal()).toBe(false);

		getClient.mockReturnValue('sqlite');

		const db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
		});

		active = db;
		const begins: string[] = [];

		db.on('query', (q: { sql: string }) => {
			const sql = q.sql.trim();
			if (/^begin/i.test(sql)) begins.push(sql);
		});

		await db.raw('create table t (id integer primary key)');

		await mod.runInBoundSerializable(
			db,
			async (trx) => {
				await trx('t').insert({ id: 1 });
			},
			async () => undefined
		);

		expect(requiredInternal()).toBe(true);
		expect(begins).toContain('BEGIN IMMEDIATE;');
	});
});
