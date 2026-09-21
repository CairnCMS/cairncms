import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidPayloadException } from '../exceptions/index.js';
import { assertNoParentCycle } from './assert-no-parent-cycle.js';

describe('assertNoParentCycle on a real SQLite database', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('name');
			table.uuid('parent');
		});

		await db('directus_folders').insert([
			{ id: 'a', name: 'a', parent: null },
			{ id: 'b', name: 'b', parent: 'a' },
			{ id: 'c', name: 'c', parent: 'b' },
			{ id: 'd', name: 'd', parent: null },
		]);
	});

	afterEach(async () => {
		await db.destroy();
	});

	function guard(keys: string[], payload: Record<string, any>): Promise<void> {
		return assertNoParentCycle(db, 'directus_folders', 'id', keys, payload);
	}

	it('is a no-op when the parent field is absent', async () => {
		await expect(guard(['c'], { name: 'renamed' })).resolves.toBeUndefined();
	});

	it('allows a move to root', async () => {
		await expect(guard(['c'], { parent: null })).resolves.toBeUndefined();
	});

	it('allows a move to an unrelated subtree', async () => {
		await expect(guard(['c'], { parent: 'd' })).resolves.toBeUndefined();
	});

	it('allows an unchanged-parent resubmit', async () => {
		await expect(guard(['c'], { parent: 'b' })).resolves.toBeUndefined();
	});

	it('allows a create under an existing folder', async () => {
		await expect(guard(['fresh'], { parent: 'a' })).resolves.toBeUndefined();
	});

	it('refuses self-parenting', async () => {
		await expect(guard(['b'], { parent: 'b' })).rejects.toBeInstanceOf(InvalidPayloadException);
	});

	it('refuses a self-parent create', async () => {
		await expect(guard(['u'], { parent: 'u' })).rejects.toBeInstanceOf(InvalidPayloadException);
	});

	it('refuses parenting a folder under its own descendant', async () => {
		await expect(guard(['a'], { parent: 'c' })).rejects.toBeInstanceOf(InvalidPayloadException);
	});

	it('refuses a missing ancestor', async () => {
		await expect(guard(['c'], { parent: 'ghost' })).rejects.toBeInstanceOf(InvalidPayloadException);
	});

	it('terminates on a pre-existing data cycle rather than looping', async () => {
		await db('directus_folders').where({ id: 'a' }).update({ parent: 'c' });
		await expect(guard(['fresh'], { parent: 'a' })).rejects.toBeInstanceOf(InvalidPayloadException);
	});

	it('refuses a mixed-case self-parent through canonical comparison', async () => {
		await expect(guard(['B'], { parent: 'B' })).rejects.toBeInstanceOf(InvalidPayloadException);
	});

	it('resolves a move to a parent stored with an uppercase id, preserving the lookup spelling', async () => {
		await db('directus_folders').insert({ id: 'E5F6A7B8', name: 'up', parent: null });
		await expect(guard(['c'], { parent: 'E5F6A7B8' })).resolves.toBeUndefined();
	});

	it('does not touch an unguarded collection', async () => {
		await expect(assertNoParentCycle(db, 'directus_other', 'id', ['x'], { parent: 'y' })).resolves.toBeUndefined();
	});

	it('refuses a descendant-parenting move with a fixed message that discloses no ancestor id', async () => {
		const error = await guard(['a'], { parent: 'c' }).catch((err) => err);
		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.message).toBe('Moving a folder here would create a parent cycle.');
	});

	it('refuses a missing ancestor with a fixed message', async () => {
		const error = await guard(['c'], { parent: 'ghost' }).catch((err) => err);
		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.message).toBe('The requested parent folder does not exist.');
	});

	it('reports a pre-existing data cycle with a fixed message', async () => {
		await db('directus_folders').where({ id: 'a' }).update({ parent: 'c' });
		const error = await guard(['fresh'], { parent: 'a' }).catch((err) => err);
		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.message).toBe('The folder hierarchy already contains a cycle.');
	});
});
