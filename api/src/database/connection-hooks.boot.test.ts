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
		vi.doUnmock('../env.js');
		vi.resetModules();
	});

	it('applies foreign_keys and busy_timeout on a real sqlite connection', async () => {
		vi.doMock('../env.js', async (importOriginal) => {
			const actual = await importOriginal<typeof import('../env.js')>();

			const withoutDbKeys = Object.fromEntries(
				Object.entries(actual.getEnv()).filter(([key]) => key.startsWith('DB_') === false)
			);

			const values = { ...withoutDbKeys, DB_CLIENT: 'sqlite3', DB_FILENAME: tmpFile };

			return { ...actual, default: values, getEnv: () => values };
		});

		const { default: getDatabase } = await import('./index.js');
		const { sqliteAfterCreate } = await import('./connection-hooks.js');
		db = getDatabase();

		expect((db.client as any).config.pool.afterCreate).toBe(sqliteAfterCreate);

		const foreignKeys = await db.raw('PRAGMA foreign_keys');
		const busyTimeout = await db.raw('PRAGMA busy_timeout');

		expect(foreignKeys[0].foreign_keys).toBe(1);
		expect(busyTimeout[0].timeout).toBe(5000);
	});
});
