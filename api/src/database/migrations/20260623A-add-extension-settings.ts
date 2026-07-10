import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('cairncms_extension_settings', (table) => {
		table.uuid('id').primary().notNullable();
		table.string('extension', 255).notNullable();
		table.string('scope', 16).notNullable();
		table.string('scope_key', 64).notNullable().defaultTo('');
		table.string('key', 64).notNullable();
		table.text('value').notNullable();

		table.unique(['extension', 'scope', 'scope_key', 'key'], {
			indexName: 'cairncms_extension_settings_subject_unique',
		});
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTable('cairncms_extension_settings');
}
