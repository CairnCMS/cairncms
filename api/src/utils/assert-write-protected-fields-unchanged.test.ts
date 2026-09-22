import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWriteProtectedFieldsUnchanged } from './assert-write-protected-fields-unchanged.js';

describe('assertWriteProtectedFieldsUnchanged', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			useNullAsDefault: true,
			connection: ':memory:',
			pool: { min: 1, max: 1 },
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.string('id').primary();
			table.string('name');
			table.string('key');
		});

		await db('directus_folders').insert([
			{ id: 'f-a', name: 'Docs', key: 'docs' },
			{ id: 'f-b', name: 'Images', key: 'images' },
		]);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('rejects a change to a protected field', async () => {
		await expect(
			assertWriteProtectedFieldsUnchanged(db, 'directus_folders', 'id', ['f-a'], { key: 'media' })
		).rejects.toThrow();
	});

	it('allows a protected field resubmitted at its current value', async () => {
		await expect(
			assertWriteProtectedFieldsUnchanged(db, 'directus_folders', 'id', ['f-a'], { key: 'docs', name: 'Renamed' })
		).resolves.toBeUndefined();
	});

	it('does not query when the payload omits every protected field', async () => {
		await expect(
			assertWriteProtectedFieldsUnchanged(db, 'directus_folders', 'id', ['f-a'], { name: 'Renamed' })
		).resolves.toBeUndefined();
	});

	it('rejects the whole batch when any targeted row would change', async () => {
		await expect(
			assertWriteProtectedFieldsUnchanged(db, 'directus_folders', 'id', ['f-a', 'f-b'], { key: 'docs' })
		).rejects.toThrow();
	});

	it('ignores collections that declare no protected fields', async () => {
		await expect(
			assertWriteProtectedFieldsUnchanged(db, 'directus_users', 'id', ['f-a'], { key: 'anything' })
		).resolves.toBeUndefined();
	});

	it('ignores a collection whose name collides with an object prototype property', async () => {
		await expect(
			assertWriteProtectedFieldsUnchanged(db, 'constructor', 'id', ['f-a'], { key: 'anything' })
		).resolves.toBeUndefined();
	});
});
