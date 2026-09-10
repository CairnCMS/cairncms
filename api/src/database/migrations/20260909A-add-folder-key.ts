import type { Knex } from 'knex';
import { generateBoundedKey } from '../../utils/config/generate-bounded-key.js';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_folders', (table) => {
		table.string('key', 255).nullable();
	});

	const folders = await knex('directus_folders').select('id', 'name').orderBy('id', 'asc');
	const usedKeys = new Set<string>();

	for (const folder of folders) {
		const key = generateBoundedKey(folder.name ?? '', usedKeys, { fallback: 'folder' });
		await knex('directus_folders').where({ id: folder.id }).update({ key });
	}

	await knex.schema.alterTable('directus_folders', (table) => {
		table.dropNullable('key');
	});

	await knex.schema.alterTable('directus_folders', (table) => {
		table.unique(['key']);
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_folders', (table) => {
		table.dropUnique(['key']);
	});

	await knex.schema.alterTable('directus_folders', (table) => {
		table.dropColumn('key');
	});
}
