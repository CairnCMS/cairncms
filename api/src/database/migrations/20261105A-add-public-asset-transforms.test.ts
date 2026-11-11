import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSqliteClient } from '../sqlite-driver.js';
import { down, up } from './20261105A-add-public-asset-transforms.js';

describe('20261105A-add-public-asset-transforms', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: getSqliteClient(),
			useNullAsDefault: true,
			connection: ':memory:',
			pool: { min: 1, max: 1 },
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.string('project_name');
			table.string('storage_asset_transform', 7).defaultTo('all');
		});

		await db('directus_settings').insert({ project_name: 'Existing', storage_asset_transform: 'all' });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it('adds the column as false for existing and new rows, leaving the transformation mode unchanged', async () => {
		await up(db);

		await db('directus_settings').insert({ project_name: 'New' });

		const rows = await db('directus_settings')
			.select('project_name', 'storage_asset_transform', 'storage_asset_public_transforms')
			.orderBy('id');

		expect(
			rows.map((row) => ({ ...row, storage_asset_public_transforms: Boolean(row.storage_asset_public_transforms) }))
		).toEqual([
			{ project_name: 'Existing', storage_asset_transform: 'all', storage_asset_public_transforms: false },
			{ project_name: 'New', storage_asset_transform: 'all', storage_asset_public_transforms: false },
		]);
	});

	it('rejects a null value', async () => {
		await up(db);

		await expect(
			db('directus_settings').update({ storage_asset_public_transforms: null }).where({ project_name: 'Existing' })
		).rejects.toThrow();
	});

	it('removes the column on down', async () => {
		await up(db);
		await down(db);

		expect(await db.schema.hasColumn('directus_settings', 'storage_asset_public_transforms')).toBe(false);

		expect(await db('directus_settings').select('project_name', 'storage_asset_transform')).toEqual([
			{ project_name: 'Existing', storage_asset_transform: 'all' },
		]);
	});
});
