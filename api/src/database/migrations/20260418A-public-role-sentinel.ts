import { PUBLIC_ROLE_ID } from '@directus/constants';
import type { Knex } from 'knex';
import { getHelpers } from '../helpers/index.js';

export async function up(knex: Knex): Promise<void> {
	const duplicates = await knex('directus_permissions')
		.select('role', 'collection', 'action')
		.count('* as count')
		.groupBy('role', 'collection', 'action')
		.having(knex.raw('count(*) > 1'));

	if (duplicates.length > 0) {
		throw new Error(
			`Migration cannot proceed: ${duplicates.length} duplicate (role, collection, action) tuples found in directus_permissions.\n` +
				`Resolve duplicates before re-running this migration.\n` +
				duplicates
					.map((d: any) => `  - role=${d.role ?? 'NULL'} collection=${d.collection} action=${d.action} (×${d.count})`)
					.join('\n')
		);
	}

	const idCollision = await knex('directus_roles').where('id', PUBLIC_ROLE_ID).first();

	if (idCollision) {
		throw new Error(
			`Migration cannot proceed: a role with id=${PUBLIC_ROLE_ID} already exists. ` +
				`This UUID is reserved for the public role sentinel.`
		);
	}

	const keyCollision = await knex('directus_roles').where('key', 'public').first();

	if (keyCollision) {
		throw new Error(
			`Migration cannot proceed: a role with key='public' already exists (id=${keyCollision.id}). ` +
				`The key 'public' is reserved for the sentinel role. ` +
				`Rename the existing role's key before re-running this migration.`
		);
	}

	await knex('directus_roles').insert({
		id: PUBLIC_ROLE_ID,
		key: 'public',
		name: '$t:public_label',
		icon: 'public',
		admin_access: false,
		app_access: false,
		enforce_tfa: false,
		description: null,
		ip_access: null,
	});

	await knex('directus_permissions').whereNull('role').update({ role: PUBLIC_ROLE_ID });

	await getHelpers(knex).schema.changeNullable('directus_permissions', 'role', false);

	await knex.schema.alterTable('directus_permissions', (table) => {
		table.unique(['role', 'collection', 'action'], { indexName: 'directus_permissions_identity_unique' });
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_permissions', (table) => {
		table.dropUnique(['role', 'collection', 'action'], 'directus_permissions_identity_unique');
	});

	await getHelpers(knex).schema.changeNullable('directus_permissions', 'role', true);

	await knex('directus_permissions').where('role', PUBLIC_ROLE_ID).update({ role: null });

	await knex('directus_roles').where('id', PUBLIC_ROLE_ID).delete();
}
