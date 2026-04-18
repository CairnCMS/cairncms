import { normalizeRoleKey } from '@directus/utils';
import type { Knex } from 'knex';

const RESERVED_KEYS = new Set(['public']);

export async function up(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_roles', (table) => {
		table.string('key', 255).nullable();
	});

	const roles = await knex('directus_roles').select('id', 'name').orderBy('id', 'asc');
	const usedKeys = new Set<string>();

	for (const role of roles) {
		let candidate = normalizeRoleKey(role.name);
		if (candidate === '') candidate = 'role';

		let key = candidate;
		let suffix = 2;

		while (usedKeys.has(key) || RESERVED_KEYS.has(key)) {
			key = `${candidate}_${suffix}`;
			suffix++;
		}

		usedKeys.add(key);
		await knex('directus_roles').where({ id: role.id }).update({ key });
	}

	await knex.schema.alterTable('directus_roles', (table) => {
		table.dropNullable('key');
	});

	await knex.schema.alterTable('directus_roles', (table) => {
		table.unique(['key']);
	});

	const duplicates = await knex('directus_permissions')
		.select('role', 'collection', 'action')
		.count('* as count')
		.groupBy('role', 'collection', 'action')
		.having(knex.raw('count(*) > 1'));

	if (duplicates.length > 0) {
		console.warn(
			`[migration 20260417A] Found ${duplicates.length} duplicate (role, collection, action) tuples in directus_permissions.\n` +
				`These are tolerated at runtime but will block 'config snapshot' until resolved.\n` +
				duplicates
					.map(
						(d: any) =>
							`  - role=${d.role ?? 'NULL'} collection=${d.collection} action=${d.action} (×${d.count})`
					)
					.join('\n')
		);
	}
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_roles', (table) => {
		table.dropUnique(['key']);
	});

	await knex.schema.alterTable('directus_roles', (table) => {
		table.dropColumn('key');
	});
}
