import type { Knex } from 'knex';
import logger from '../../logger.js';

const TABLE = 'directus_webhooks';

function redactUrl(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}`;
	} catch {
		return '[unparseable]';
	}
}

export async function up(knex: Knex): Promise<void> {
	if (!(await knex.schema.hasTable(TABLE))) return;

	const rows = await knex(TABLE).select('id', 'name', 'method', 'url', 'status', 'actions', 'collections');

	if (rows.length > 0) {
		const active = rows.filter((r) => r.status === 'active').length;

		const redacted = rows.map((r) => ({
			id: r.id,
			name: r.name,
			method: r.method,
			url_origin: redactUrl(r.url),
			status: r.status,
			actions: r.actions,
			collections: r.collections,
		}));

		logger.warn(
			{
				active_count: active,
				total_count: rows.length,
				webhooks: redacted,
			},
			`Removing legacy directus_webhooks table (${active} active, ${rows.length} total). Records are NOT auto-migrated to flows. URL paths, query strings, and headers are redacted from this log because they commonly carry credentials. If you need the exact webhook targets, query directus_webhooks before running this migration.`
		);
	}

	await knex.schema.dropTable(TABLE);
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.createTable(TABLE, (table) => {
		table.increments('id');
		table.string('name', 255).notNullable();
		table.string('method', 10).notNullable().defaultTo('POST');
		table.text('url').notNullable();
		table.string('status', 10).notNullable().defaultTo('active');
		table.boolean('data').notNullable().defaultTo(true);
		table.string('actions', 100).notNullable();
		table.text('collections').notNullable();
		table.json('headers');
	});
}
